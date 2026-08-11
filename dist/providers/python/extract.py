import ast
import json
import keyword
import math
import operator
import sys


# //////// Constants

ASSIGNMENT_NODES = (ast.Assign, ast.AnnAssign, ast.AugAssign, ast.NamedExpr)
CONTROL_NODES = (ast.If, ast.For, ast.AsyncFor, ast.While, ast.With, ast.AsyncWith, ast.Try, ast.Match)
FINAL_MODULES = {"typing", "typing_extensions"}


# //////// Helpers

def descriptor(kind, name):
    return {"kind": kind, "name": name}


def descriptor_key(descriptors):
    return tuple((item["kind"], item["name"]) for item in descriptors)


def diagnostic(message):
    return {"severity": "error", "message": message}


def names_in_target(target):
    if isinstance(target, ast.Name):
        return [target]
    if isinstance(target, (ast.Tuple, ast.List)):
        names = []
        for element in target.elts:
            names.extend(names_in_target(element))
        return names
    if isinstance(target, ast.Starred):
        return names_in_target(target.value)
    return []


def pattern_names(pattern):
    names = []
    if isinstance(pattern, ast.MatchAs) and pattern.name is not None:
        names.append(pattern.name)
    if isinstance(pattern, ast.MatchStar) and pattern.name is not None:
        names.append(pattern.name)
    if isinstance(pattern, ast.MatchMapping) and pattern.rest is not None:
        names.append(pattern.rest)
    for child in ast.iter_child_nodes(pattern):
        names.extend(pattern_names(child))
    return names


def assignment_targets(node):
    if isinstance(node, ast.Assign):
        names = []
        for target in node.targets:
            names.extend(names_in_target(target))
        return names
    if isinstance(node, (ast.AnnAssign, ast.AugAssign, ast.NamedExpr)):
        return names_in_target(node.target)
    if isinstance(node, (ast.For, ast.AsyncFor)):
        return names_in_target(node.target)
    if isinstance(node, (ast.With, ast.AsyncWith)):
        names = []
        for item in node.items:
            if item.optional_vars is not None:
                names.extend(names_in_target(item.optional_vars))
        return names
    return []


def source_line(lines, line_number):
    if line_number < 1 or line_number > len(lines):
        return ""
    return lines[line_number - 1]


def compare_position(left, right):
    if left["line"] != right["line"]:
        return left["line"] - right["line"]
    return left["character"] - right["character"]


def range_key(value):
    return (
        value["start"]["line"],
        value["start"]["character"],
        value["end"]["line"],
        value["end"]["character"],
    )


def ranges_equal(left, right):
    return range_key(left) == range_key(right)


def range_contains(outer, inner):
    return compare_position(outer["start"], inner["start"]) <= 0 and compare_position(
        inner["end"], outer["end"]
    ) <= 0


def ranges_overlap(left, right):
    return compare_position(left["start"], right["end"]) < 0 and compare_position(
        right["start"], left["end"]
    ) < 0


def utf16_length(value):
    return len(value.encode("utf-16-le")) // 2


def codepoint_index(value, utf16_column):
    used = 0
    for index, character in enumerate(value):
        if used >= utf16_column:
            return index
        used += 2 if ord(character) > 0xFFFF else 1
    return len(value)


def text_for_range(text, value):
    lines = text.splitlines(keepends=True)
    start = value["start"]
    end = value["end"]
    if start["line"] < 0 or end["line"] >= len(lines):
        return ""
    start_character = codepoint_index(lines[start["line"]], start["character"])
    end_character = codepoint_index(lines[end["line"]], end["character"])
    if start["line"] == end["line"]:
        return lines[start["line"]][start_character:end_character]
    parts = [lines[start["line"]][start_character:]]
    parts.extend(lines[line] for line in range(start["line"] + 1, end["line"]))
    parts.append(lines[end["line"]][:end_character])
    return "".join(parts)


class Analyzer:
    def __init__(self, module, text):
        self.module = module
        self.text = text
        self.package_init = module.replace("\\", "/").split("/")[-1] == "__init__.py"
        self.lines = text.splitlines(keepends=True)
        self.export_names = None
        self.declarations = {}
        self.references = []
        self.imports = []
        self.tree = None
        self.final_names = set()
        self.final_modules = set()
        self.declaration_occurrences = {}
        self.conditional_declarations = set()
        self.scope_infos = {}
        self.duplicate_scopes = set()
        self.declarations_by_scope = {}
        self.type_annotations = []
        self.import_bindings = []
        self.declaration_nodes = {}
        self.node_scope_paths = {}
        self.inferred_types = []
        self.literals = []

    def position(self, line_number, byte_column):
        line = source_line(self.lines, line_number)
        prefix = line.encode("utf-8")[:byte_column].decode("utf-8")
        return {"line": line_number - 1, "character": utf16_length(prefix)}

    def range_of(self, node):
        start_line = getattr(node, "lineno", 1)
        start_column = getattr(node, "col_offset", 0)
        end_line = getattr(node, "end_lineno", start_line)
        end_column = getattr(node, "end_col_offset", start_column)
        return {"start": self.position(start_line, start_column), "end": self.position(end_line, end_column)}

    def range_from_columns(self, line_number, start_column, end_column):
        return {
            "start": self.position(line_number, start_column),
            "end": self.position(line_number, end_column),
        }

    def imported_name(self, alias, local_only=False):
        if alias.name == "*":
            return None
        if local_only:
            local_name = alias.asname or alias.name.split(".")[0]
            if alias.asname is not None:
                local_start = alias.end_col_offset - len(alias.asname.encode("utf-8"))
            else:
                local_start = alias.col_offset
            local_end = local_start + len(local_name.encode("utf-8"))
            return {
                "local": local_name,
                "localRange": self.range_from_columns(alias.lineno, local_start, local_end),
            }
        if "." in alias.name:
            return None
        name_end = alias.col_offset + len(alias.name.encode("utf-8"))
        imported = {
            "name": alias.name,
            "range": self.range_from_columns(alias.lineno, alias.col_offset, name_end),
        }
        if alias.asname is not None and alias.asname != alias.name:
            local_start = alias.end_col_offset - len(alias.asname.encode("utf-8"))
            imported["local"] = alias.asname
            imported["localRange"] = self.range_from_columns(alias.lineno, local_start, alias.end_col_offset)
        return imported

    def reference_range(self, node):
        if not isinstance(node, ast.Attribute):
            return self.range_of(node)
        end_line = getattr(node, "end_lineno", 1)
        end_column = getattr(node, "end_col_offset", 0)
        end = self.position(end_line, end_column)
        start = self.position(end_line, end_column - len(node.attr.encode("utf-8")))
        return {"start": start, "end": end}

    def selection_of(self, node, name):
        line_number = getattr(node, "lineno", 1)
        line = source_line(self.lines, line_number)
        start_byte = getattr(node, "col_offset", 0)
        start_character = len(line.encode("utf-8")[:start_byte].decode("utf-8"))
        character = line.find(name, start_character)
        if character < 0:
            character = start_character
        return {
            "start": {"line": line_number - 1, "character": utf16_length(line[:character])},
            "end": {"line": line_number - 1, "character": utf16_length(line[: character + len(name)])},
        }

    def signature_of(self, node):
        line = source_line(self.lines, getattr(node, "lineno", 1)).strip()
        return line or None

    def metrics_of(self, node):
        start_line = getattr(node, "lineno", 1)
        end_line = getattr(node, "end_lineno", start_line)
        metrics = {"lines": max(1, end_line - start_line + 1)}
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            arguments = node.args
            metrics["parameters"] = (
                len(arguments.posonlyargs)
                + len(arguments.args)
                + len(arguments.kwonlyargs)
                + (1 if arguments.vararg is not None else 0)
                + (1 if arguments.kwarg is not None else 0)
            )
            visitor = MetricsVisitor()
            for statement in node.body:
                visitor.visit(statement)
            metrics["nesting"] = visitor.nesting
            metrics["branches"] = visitor.branches
        return metrics

    def literal_names(self, value):
        if not isinstance(value, (ast.List, ast.Tuple, ast.Set)):
            return None
        names = []
        for element in value.elts:
            if not isinstance(element, ast.Constant) or not isinstance(element.value, str):
                return None
            names.append(element.value)
        return names

    def nested_statements(self, node):
        if not isinstance(node, CONTROL_NODES):
            return []
        groups = []
        for field in ("body", "orelse", "finalbody"):
            group = getattr(node, field, None)
            if group:
                groups.append(group)
        if isinstance(node, ast.Try):
            for handler in node.handlers:
                groups.append(handler.body)
        if isinstance(node, ast.Match):
            for case in node.cases:
                groups.append(case.body)
        return groups

    def _walk_statement_tree(self, statements):
        yield statements
        for node in statements:
            for nested in self.nested_statements(node):
                yield from self._walk_statement_tree(nested)

    def find_export_names(self):
        found = set()
        known = False
        for statements in self._walk_statement_tree(self.tree.body):
            for node in statements:
                if not isinstance(node, ASSIGNMENT_NODES):
                    continue
                targets = assignment_targets(node)
                if not any(target.id == "__all__" for target in targets if isinstance(target, ast.Name)):
                    continue
                if isinstance(node, ast.AugAssign):
                    names = self.literal_names(node.value)
                    if not isinstance(node.op, ast.Add) or not known or names is None:
                        known = False
                        continue
                    found.update(names)
                    continue
                names = self.literal_names(getattr(node, "value", None))
                if names is None:
                    known = False
                    continue
                found = set(names)
                known = True
        return found if known else None

    def find_final_bindings(self):
        bindings = {}

        def record(name, kind):
            bindings.setdefault(name, set()).add(kind)

        for statements in self._walk_statement_tree(self.tree.body):
            direct = statements is self.tree.body
            for node in statements:
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        local_name = alias.asname or alias.name.split(".")[0]
                        kind = "module" if direct and alias.name in FINAL_MODULES else ("other" if direct else "conditional")
                        record(local_name, kind)
                elif isinstance(node, ast.ImportFrom):
                    for alias in node.names:
                        if alias.name == "*":
                            continue
                        local_name = alias.asname or alias.name
                        kind = (
                            "final"
                            if direct and node.level == 0 and node.module in FINAL_MODULES and alias.name == "Final"
                            else ("other" if direct else "conditional")
                        )
                        record(local_name, kind)

                shadow_kind = "shadow" if direct else "conditional"
                if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
                    record(node.name, shadow_kind)
                elif isinstance(node, ASSIGNMENT_NODES + (ast.For, ast.AsyncFor, ast.With, ast.AsyncWith)):
                    for target in assignment_targets(node):
                        record(target.id, shadow_kind)

        self.final_names = {name for name, kinds in bindings.items() if kinds == {"final"}}
        self.final_modules = {name for name, kinds in bindings.items() if kinds == {"module"}}

    def is_final_annotation(self, node):
        if not isinstance(node, ast.AnnAssign):
            return False
        annotation = node.annotation
        if isinstance(annotation, ast.Name):
            return annotation.id in self.final_names
        if isinstance(annotation, ast.Attribute):
            return isinstance(annotation.value, ast.Name) and annotation.attr == "Final" and annotation.value.id in self.final_modules
        if isinstance(annotation, ast.Subscript):
            return self.is_final_annotation_value(annotation.value)
        return False

    def is_final_annotation_value(self, node):
        if isinstance(node, ast.Name):
            return node.id in self.final_names
        return (
            isinstance(node, ast.Attribute)
            and isinstance(node.value, ast.Name)
            and node.attr == "Final"
            and node.value.id in self.final_modules
        )

    def ensure_scope(self, scope_path, scope_kind):
        key = descriptor_key(scope_path)
        existing = self.scope_infos.get(key)
        if existing is not None:
            if existing["kind"] != scope_kind:
                self.duplicate_scopes.add(key)
            return existing
        info = {
            "kind": scope_kind,
            "path": list(scope_path),
            "locals": set(),
            "parameters": set(),
            "globals": set(),
            "nonlocals": set(),
            "conditional": set(),
            "starImport": False,
            "dynamic": False,
        }
        self.scope_infos[key] = info
        return info

    def add_scope_name(self, info, name, conditional):
        info["locals"].add(name)
        if conditional:
            info["conditional"].add(name)

    def mark_declaration_conditional(self, scope_path, name, conditional):
        if conditional:
            self.conditional_declarations.add(descriptor_key(scope_path + [descriptor("term", name)]))

    def has_dynamic_call(self, node, root=True):
        if not root and isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            return False
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in {"exec", "eval"}:
            return True
        return any(self.has_dynamic_call(child, False) for child in ast.iter_child_nodes(node))

    def collect_namedexpr_bindings(self, node, info, conditional):
        if isinstance(node, ast.NamedExpr):
            if isinstance(node.target, ast.Name):
                self.add_scope_name(info, node.target.id, conditional)
        if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.comprehension)):
            return
        for child in ast.iter_child_nodes(node):
            self.collect_namedexpr_bindings(child, info, conditional)

    def collect_scope(self, statements, scope_path, scope_kind, conditional=False):
        info = self.ensure_scope(scope_path, scope_kind)
        for node in statements:
            if not isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and self.has_dynamic_call(node):
                info["dynamic"] = True
            self.collect_namedexpr_bindings(node, info, conditional)
            if isinstance(node, ast.Global):
                info["globals"].update(node.names)
                continue
            if isinstance(node, ast.Nonlocal):
                info["nonlocals"].update(node.names)
                continue
            if isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name == "*":
                        info["starImport"] = True
                    else:
                        self.add_scope_name(info, alias.asname or alias.name.split(".")[0], conditional)
                continue
            if isinstance(node, ast.ImportFrom):
                for alias in node.names:
                    if alias.name == "*":
                        info["starImport"] = True
                    else:
                        self.add_scope_name(info, alias.asname or alias.name, conditional)
                continue
            if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
                self.add_scope_name(info, node.name, conditional)
                child_kind = "class" if isinstance(node, ast.ClassDef) else "function"
                child_path = scope_path + [descriptor("type" if child_kind == "class" else "method", node.name)]
                self.mark_declaration_conditional(scope_path, node.name, conditional)
                if child_kind == "function":
                    child_info = self.ensure_scope(child_path, child_kind)
                    arguments = node.args
                    for argument in [*arguments.posonlyargs, *arguments.args, *arguments.kwonlyargs]:
                        self.add_scope_name(child_info, argument.arg, False)
                        child_info["parameters"].add(argument.arg)
                    if arguments.vararg:
                        self.add_scope_name(child_info, arguments.vararg.arg, False)
                        child_info["parameters"].add(arguments.vararg.arg)
                    if arguments.kwarg:
                        self.add_scope_name(child_info, arguments.kwarg.arg, False)
                        child_info["parameters"].add(arguments.kwarg.arg)
                self.collect_scope(node.body, child_path, child_kind)
                continue
            if isinstance(node, ASSIGNMENT_NODES):
                for target in assignment_targets(node):
                    self.add_scope_name(info, target.id, conditional)
                    if scope_kind in {"module", "class"}:
                        self.mark_declaration_conditional(scope_path, target.id, conditional)
            if isinstance(node, (ast.For, ast.AsyncFor, ast.With, ast.AsyncWith)):
                for target in assignment_targets(node):
                    self.add_scope_name(info, target.id, conditional)
                    if scope_kind in {"module", "class"}:
                        self.mark_declaration_conditional(scope_path, target.id, conditional)
            if isinstance(node, ast.If):
                self.collect_scope(node.body, scope_path, scope_kind, True)
                self.collect_scope(node.orelse, scope_path, scope_kind, True)
                continue
            if isinstance(node, (ast.For, ast.AsyncFor, ast.While)):
                self.collect_scope(node.body, scope_path, scope_kind, True)
                self.collect_scope(node.orelse, scope_path, scope_kind, True)
                continue
            if isinstance(node, (ast.With, ast.AsyncWith)):
                self.collect_scope(node.body, scope_path, scope_kind, True)
                continue
            if isinstance(node, ast.Try):
                self.collect_scope(node.body, scope_path, scope_kind, True)
                for handler in node.handlers:
                    if handler.name is not None:
                        self.add_scope_name(info, handler.name, True)
                    self.collect_scope(handler.body, scope_path, scope_kind, True)
                self.collect_scope(node.orelse, scope_path, scope_kind, True)
                self.collect_scope(node.finalbody, scope_path, scope_kind, True)
                continue
            if isinstance(node, ast.Match):
                for case in node.cases:
                    for name in pattern_names(case.pattern):
                        self.add_scope_name(info, name, True)
                    self.collect_scope(case.body, scope_path, scope_kind, True)
                continue

    def prepare_binding_index(self):
        self.scope_infos = {}
        self.duplicate_scopes = set()
        self.conditional_declarations = set()
        self.collect_scope(self.tree.body, [], "module")
        self.declarations_by_scope = {}
        for declaration_path, entries in self.declaration_occurrences.items():
            if not declaration_path:
                continue
            scope_key = declaration_path[:-1]
            name = declaration_path[-1][1]
            self.declarations_by_scope.setdefault(scope_key, {}).setdefault(name, []).extend(entries)

    def unbound_binding(self, reason, detail):
        return {"status": "unbound", "reason": reason, "detail": detail}

    def declaration_candidate(self, scope_key, name, role, reference_position):
        entries = self.declarations_by_scope.get(scope_key, {}).get(name, [])
        if role in {"extends", "typeUse"}:
            entries = [entry for entry in entries if entry["kind"] == "class"]
        if not entries:
            return None
        if len(entries) != 1:
            return self.unbound_binding("Ambiguous", "multiple same-file declarations match this name")
        declaration = entries[0]
        if descriptor_key(declaration["descriptorPath"]) in self.conditional_declarations:
            return self.unbound_binding("Ambiguous", "the matching declaration is conditional")
        if role in {"extends", "typeUse"}:
            declaration_position = declaration["range"]["start"]
            if (declaration_position["line"], declaration_position["character"]) > (
                reference_position["line"],
                reference_position["character"],
            ):
                return self.unbound_binding("NotImplemented", "forward base or annotation binding is not supported")
        return {"status": "bound", "descriptorPath": declaration["descriptorPath"]}

    def binding_for(self, name, role, scope_path, reference_position, bindable=True, blocked_reason=None):
        if blocked_reason is not None:
            return self.unbound_binding("NotIndexed", blocked_reason)
        if not bindable:
            return self.unbound_binding("Ambiguous", "attribute binding requires a resolved receiver")
        if role not in {"call", "read", "write", "extends", "typeUse"}:
            return self.unbound_binding("NotImplemented", "this reference role is not indexed")

        original_path = list(scope_path)
        current_key = descriptor_key(original_path)
        current = self.scope_infos.get(current_key)
        if current is None:
            return self.unbound_binding("NotImplemented", "reference scope is not indexed")
        if current["dynamic"]:
            return self.unbound_binding("RuntimeConstructed", "exec or eval can change this scope")

        global_name = current["kind"] == "function" and name in current["globals"]
        nonlocal_name = current["kind"] == "function" and name in current["nonlocals"]
        if global_name:
            paths = [[]]
        else:
            paths = [original_path]
            while paths[-1]:
                parent = paths[-1][:-1]
                if parent and parent[-1]["kind"] == "type" and any(
                    item["kind"] == "method" for item in original_path[len(parent) :]
                ):
                    parent = parent[:-1]
                paths.append(parent)
        for path in paths:
            key = descriptor_key(path)
            info = self.scope_infos.get(key)
            if info is None:
                continue
            if key in self.duplicate_scopes:
                return self.unbound_binding("Ambiguous", "same-named scopes make this lookup ambiguous")
            if info["dynamic"]:
                return self.unbound_binding("RuntimeConstructed", "exec or eval can change this scope")
            if nonlocal_name and key == current_key:
                continue
            if nonlocal_name and info["kind"] != "function":
                continue
            if name in info["conditional"]:
                return self.unbound_binding("Ambiguous", "a conditional definition can shadow this name")
            candidate = self.declaration_candidate(key, name, role, reference_position)
            if isinstance(candidate, dict) and candidate.get("status") == "bound":
                if key == () and info["starImport"]:
                    return self.unbound_binding("Ambiguous", "a star import can shadow module names")
                return candidate
            if isinstance(candidate, dict):
                return candidate
            if name in info["locals"]:
                return self.unbound_binding("NotIndexed", "local, parameter, or imported binding is not indexed")
            if nonlocal_name and info["kind"] == "function":
                return self.unbound_binding("NotIndexed", "the nonlocal target is not indexed")
        return self.unbound_binding("NotImplemented", "no certain same-file declaration; cross-file binding is not implemented")

    def is_exported(self, name, module_scope, parent_exported):
        if not module_scope:
            return parent_exported
        if self.export_names is not None:
            return name in self.export_names
        return not name.startswith("_")

    def is_explicitly_exported(self, name):
        return self.export_names is not None and name in self.export_names

    def is_from_reexport(self, aliases, scope_path):
        # A package initializer is a barrel; other imports need explicit __all__ exposure.
        if scope_path:
            return False
        if self.package_init:
            return True
        return any(self.is_explicitly_exported(alias.asname or alias.name) for alias in aliases)

    def visibility_of(self, name, scope_kind, exported):
        if scope_kind == "function":
            return "local"
        if scope_kind == "module":
            return "public" if exported else "fileLocal"
        if name.startswith("__") and not name.endswith("__"):
            return "private"
        if name.startswith("_"):
            return "protected"
        return "public"

    def add_type_annotation(self, anchor_node, anchor_name, annotation, scope_path=None):
        text = ast.get_source_segment(self.text, annotation)
        if text is None or text == "":
            return None
        anchor_range = self.selection_of(anchor_node, anchor_name)
        annotation_range = self.range_of(annotation)
        if not any(
            item["anchorRange"] == anchor_range
            and item["annotationRange"] == annotation_range
            and item["text"] == text
            for item in self.type_annotations
        ):
            self.type_annotations.append(
                {
                    "anchorRange": anchor_range,
                    "annotationRange": annotation_range,
                    "text": text,
                    "forwardReference": isinstance(annotation, ast.Constant)
                    and isinstance(annotation.value, str),
                    "_annotationNode": annotation,
                    "_scopePath": list(scope_path or []),
                }
            )
        return text

    def named_type_descriptor(self, annotation, scope_path):
        if not isinstance(annotation, ast.Name):
            return None
        binding = self.binding_for(annotation.id, "typeUse", scope_path, self.range_of(annotation)["start"])
        return binding.get("descriptorPath") if binding.get("status") == "bound" else None

    def refresh_type_descriptors(self):
        for raw in self.declarations.values():
            path_key = descriptor_key(raw["descriptorPath"])
            nodes = self.declaration_nodes.get(path_key, [])
            node = nodes[-1] if nodes else None
            annotation = None
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                annotation = node.returns
            elif isinstance(node, ast.AnnAssign):
                annotation = node.annotation
            if annotation is None:
                continue
            if isinstance(annotation, ast.Name):
                raw["typeReference"] = {
                    "name": annotation.id,
                    "range": self.range_of(annotation),
                    "role": "typeUse",
                }
            descriptor_path = self.named_type_descriptor(annotation, raw["descriptorPath"][:-1])
            if descriptor_path is not None:
                raw["typeDescriptorPath"] = descriptor_path

        for item in self.type_annotations:
            annotation = item.pop("_annotationNode", None)
            scope_path = item.pop("_scopePath", [])
            if annotation is None:
                continue
            if isinstance(annotation, ast.Name):
                item["typeReference"] = {
                    "name": annotation.id,
                    "range": self.range_of(annotation),
                    "role": "typeUse",
                }
            descriptor_path = self.named_type_descriptor(annotation, scope_path)
            if descriptor_path is not None:
                item["typeDescriptorPath"] = descriptor_path

    def add_declaration(
        self,
        node,
        selection_node,
        name,
        declaration_kind,
        descriptor_path,
        scope_kind,
        module_scope,
        parent_exported,
    ):
        exported = self.is_exported(name, module_scope, parent_exported)
        raw = {
            "name": name,
            "kind": declaration_kind,
            "descriptorPath": descriptor_path,
            "containerPath": descriptor_path[:-1],
            "range": self.range_of(node),
            "selectionRange": self.selection_of(selection_node, name),
            "visibility": self.visibility_of(name, scope_kind, exported),
            "exported": exported,
        }
        if not isinstance(node, ast.arg):
            signature = self.signature_of(node)
            if signature is not None:
                raw["signature"] = signature
            raw["metrics"] = self.metrics_of(node)
        if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            doc = ast.get_docstring(node, clean=False)
            if doc is not None:
                raw["docComment"] = doc
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.returns is not None:
                type_text = self.add_type_annotation(node, name, node.returns, descriptor_path[:-1])
                if type_text is not None:
                    raw["typeText"] = type_text
                    raw["typeForwardReference"] = isinstance(node.returns, ast.Constant) and isinstance(
                        node.returns.value, str
                    )
        elif isinstance(node, ast.AnnAssign):
            type_text = self.add_type_annotation(selection_node, name, node.annotation, descriptor_path[:-1])
            if type_text is not None:
                raw["typeText"] = type_text
                raw["typeForwardReference"] = isinstance(node.annotation, ast.Constant) and isinstance(
                    node.annotation.value, str
                )
        key = tuple(item["name"] for item in descriptor_path)
        self.declaration_occurrences.setdefault(descriptor_key(descriptor_path), []).append(raw)
        self.declarations[key] = raw
        self.declaration_nodes.setdefault(descriptor_key(descriptor_path), []).append(node)

    def add_assignment(self, node, scope_path, scope_kind, module_scope, parent_exported):
        for target in assignment_targets(node):
            if not isinstance(target, ast.Name) or target.id == "__all__":
                continue
            self.add_declaration(
                node,
                target,
                target.id,
                "constant" if self.is_final_annotation(node) else ("variable" if scope_kind == "module" else "property"),
                scope_path + [descriptor("term", target.id)],
                scope_kind,
                module_scope,
                parent_exported,
            )

    def record_definition(self, node, scope_path, scope_kind, module_scope, parent_exported):
        if isinstance(node, ast.ClassDef):
            declaration_kind = "class"
            descriptor_kind = "type"
            child_scope_kind = "class"
            child_parent_exported = self.is_exported(node.name, module_scope, parent_exported)
        else:
            declaration_kind = "method" if scope_kind == "class" else "function"
            descriptor_kind = "method"
            child_scope_kind = "function"
            child_parent_exported = False
            arguments = [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs]
            if node.args.vararg is not None:
                arguments.append(node.args.vararg)
            if node.args.kwarg is not None:
                arguments.append(node.args.kwarg)
            for argument in arguments:
                if argument.annotation is not None:
                    self.add_type_annotation(argument, argument.arg, argument.annotation, scope_path)
        descriptor_path = scope_path + [descriptor(descriptor_kind, node.name)]
        self.add_declaration(
            node,
            node,
            node.name,
            declaration_kind,
            descriptor_path,
            scope_kind,
            module_scope,
            parent_exported,
        )
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            arguments = [*node.args.posonlyargs, *node.args.args]
            if node.args.vararg is not None:
                arguments.append(node.args.vararg)
            arguments.extend(node.args.kwonlyargs)
            if node.args.kwarg is not None:
                arguments.append(node.args.kwarg)
            for argument in arguments:
                self.add_declaration(
                    argument,
                    argument,
                    argument.arg,
                    "variable",
                    descriptor_path + [descriptor("parameter", argument.arg)],
                    "function",
                    False,
                    False,
                )
        self.walk_statements(node.body, descriptor_path, child_scope_kind, False, child_parent_exported)

    def walk_statements(self, statements, scope_path, scope_kind, module_scope, parent_exported):
        for node in statements:
            self.node_scope_paths[id(node)] = list(scope_path)
            if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
                self.record_definition(node, scope_path, scope_kind, module_scope, parent_exported)
                continue
            if isinstance(node, ASSIGNMENT_NODES) or isinstance(node, (ast.For, ast.AsyncFor, ast.With, ast.AsyncWith)):
                if module_scope or scope_kind == "class":
                    self.add_assignment(node, scope_path, scope_kind, module_scope, parent_exported)
            for nested in self.nested_statements(node):
                self.walk_statements(nested, scope_path, scope_kind, module_scope, parent_exported)

    def analyze(self, tree):
        self.tree = tree
        self.export_names = self.find_export_names()
        self.find_final_bindings()
        self.walk_statements(tree.body, [], "module", True, False)
        for node in ast.walk(tree):
            if isinstance(node, ast.AnnAssign):
                for target in names_in_target(node.target):
                    self.add_type_annotation(
                        target,
                        target.id,
                        node.annotation,
                        self.node_scope_paths.get(id(node), []),
                    )
        self.prepare_binding_index()
        self.refresh_type_descriptors()
        ReferenceVisitor(self).visit(tree)
        self.inferred_types = InferenceAnalyzer(self).run()
        self.literals = LiteralVisitor(self).run()
        return {
            "declarations": list(self.declarations.values()),
            "references": self.references,
            "imports": self.imports,
            "importBindings": self.import_bindings,
            "scopeInfos": [
                {
                    "scopePath": info["path"],
                    "kind": info["kind"],
                    "locals": sorted(info["locals"]),
                    "parameters": sorted(info["parameters"]),
                    "globals": sorted(info["globals"]),
                    "nonlocals": sorted(info["nonlocals"]),
                    "conditional": sorted(info["conditional"]),
                    "dynamic": info["dynamic"],
                }
                for info in self.scope_infos.values()
            ],
            "typeAnnotations": [
                {key: value for key, value in item.items() if not key.startswith("_")}
                for item in self.type_annotations
            ],
            "inferredTypes": self.inferred_types,
            "literals": self.literals,
            "diagnostics": [],
        }


class MetricsVisitor(ast.NodeVisitor):
    def __init__(self):
        self.depth = 0
        self.nesting = 0
        self.branches = 1

    def visit_block(self, node, branches=0):
        self.depth += 1
        self.nesting = max(self.nesting, self.depth)
        self.branches += branches
        self.generic_visit(node)
        self.depth -= 1

    def visit_If(self, node):
        self.visit_block(node, 1)

    def visit_IfExp(self, node):
        self.branches += 1
        self.generic_visit(node)

    def visit_For(self, node):
        self.visit_block(node, 1)

    def visit_AsyncFor(self, node):
        self.visit_block(node, 1)

    def visit_While(self, node):
        self.visit_block(node, 1)

    def visit_With(self, node):
        self.visit_block(node)

    def visit_AsyncWith(self, node):
        self.visit_block(node)

    def visit_Try(self, node):
        self.visit_block(node)

    def visit_ExceptHandler(self, node):
        self.visit_block(node, 1)

    def visit_Match(self, node):
        self.visit_block(node, len(node.cases))

    def visit_BoolOp(self, node):
        self.branches += max(0, len(node.values) - 1)
        self.generic_visit(node)

    def visit_comprehension(self, node):
        self.branches += 1 + len(node.ifs)
        self.generic_visit(node)

    def visit_FunctionDef(self, node):
        return None

    def visit_AsyncFunctionDef(self, node):
        return None

    def visit_ClassDef(self, node):
        return None

    def visit_Lambda(self, node):
        return None


class LiteralVisitor(ast.NodeVisitor):
    def __init__(self, analyzer):
        self.analyzer = analyzer
        self.scope_path = []
        self.literals = []
        self.docstring_ids = self.find_docstrings(analyzer.tree)

    def find_docstrings(self, tree):
        found = set()
        for node in ast.walk(tree):
            if not isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            body = getattr(node, "body", [])
            if not body or not isinstance(body[0], ast.Expr):
                continue
            value = body[0].value
            if isinstance(value, ast.Constant) and isinstance(value.value, str):
                found.add(id(value))
        return found

    def add_literal(self, kind, value, node, number=None):
        item = {
            "kind": kind,
            "value": value,
            "range": self.analyzer.range_of(node),
        }
        if number is not None:
            item["number"] = number
        if self.scope_path:
            item["containerPath"] = list(self.scope_path)
        self.literals.append(item)

    def visit_declaration(self, node, path):
        old_path = self.scope_path
        self.scope_path = path
        for decorator in node.decorator_list:
            self.visit(decorator)
        if isinstance(node, ast.ClassDef):
            for base in node.bases:
                self.visit(base)
            for keyword_node in node.keywords:
                self.visit(keyword_node.value)
        else:
            self.visit(node.args)
            if node.returns is not None:
                self.visit(node.returns)
        for statement in node.body:
            self.visit(statement)
        self.scope_path = old_path

    def visit_ClassDef(self, node):
        self.visit_declaration(node, self.scope_path + [descriptor("type", node.name)])

    def visit_FunctionDef(self, node):
        self.visit_declaration(node, self.scope_path + [descriptor("method", node.name)])

    def visit_AsyncFunctionDef(self, node):
        self.visit_declaration(node, self.scope_path + [descriptor("method", node.name)])

    def visit_JoinedStr(self, node):
        if all(isinstance(value, ast.Constant) and isinstance(value.value, str) for value in node.values):
            self.add_literal("string", "".join(value.value for value in node.values), node)
            return
        for value in node.values:
            if isinstance(value, ast.FormattedValue):
                self.visit(value.value)
                if value.format_spec is not None:
                    self.visit(value.format_spec)

    def visit_UnaryOp(self, node):
        value = getattr(node.operand, "value", None)
        if (
            isinstance(node.op, (ast.UAdd, ast.USub))
            and isinstance(node.operand, ast.Constant)
            and isinstance(value, (int, float))
            and not isinstance(value, bool)
        ):
            signed = value if isinstance(node.op, ast.UAdd) else -value
            source = ast.get_source_segment(self.analyzer.text, node) or repr(signed)
            number = signed if not isinstance(signed, float) or math.isfinite(signed) else None
            self.add_literal("number", source, node, number)
            return
        self.generic_visit(node)

    def visit_Constant(self, node):
        if id(node) in self.docstring_ids:
            return
        value = node.value
        if isinstance(value, str):
            self.add_literal("string", value, node)
        elif isinstance(value, bool):
            self.add_literal("boolean", str(value), node)
        elif isinstance(value, (int, float)) and not isinstance(value, bool):
            source = ast.get_source_segment(self.analyzer.text, node) or repr(value)
            number = value if not isinstance(value, float) or math.isfinite(value) else None
            self.add_literal("number", source, node, number)

    def run(self):
        self.visit(self.analyzer.tree)
        return self.literals


class ReturnCollector(ast.NodeVisitor):
    def __init__(self):
        self.returns = []
        self.has_yield = False

    def visit_Return(self, node):
        self.returns.append(node)
        self.generic_visit(node)

    def visit_Yield(self, node):
        self.has_yield = True
        self.generic_visit(node)

    def visit_YieldFrom(self, node):
        self.has_yield = True
        self.generic_visit(node)

    def visit_FunctionDef(self, node):
        return None

    def visit_AsyncFunctionDef(self, node):
        return None

    def visit_ClassDef(self, node):
        return None

    def visit_Lambda(self, node):
        return None


class InferenceAnalyzer:
    MAX_DEPTH = 8

    def __init__(self, analyzer):
        self.analyzer = analyzer
        self.function_nodes = {}
        self.functions_by_scope = {}
        self.memo = {}
        self.function_bases = {}
        for key, nodes in analyzer.declaration_nodes.items():
            node = nodes[-1]
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            path = [descriptor(kind, name) for kind, name in key]
            self.function_nodes[key] = (path, node)
            scope_key = descriptor_key(path[:-1])
            self.functions_by_scope.setdefault((scope_key, node.name), []).append(path)

    def unknown(self, reason="NotImplemented", detail="expression type is not inferred"):
        return {"kind": "unknown", "reason": reason, "detail": detail}

    def never(self):
        return {"kind": "never"}

    def type_value(self, display, descriptor_path=None):
        value = {"kind": "type", "display": display}
        if descriptor_path is not None:
            value["descriptorPath"] = descriptor_path
        return value

    def literal(self, value):
        if value is None:
            return {"kind": "literal", "base": "None", "value": None, "display": "None"}
        if isinstance(value, bool):
            return {"kind": "literal", "base": "bool", "value": value, "display": f"Literal[{value!r}]"}
        if isinstance(value, (int, float, str)):
            return {
                "kind": "literal",
                "base": type(value).__name__,
                "value": value,
                "display": f"Literal[{value!r}]",
            }
        return self.unknown(detail="literal value is not supported")

    def join(self, values):
        unknown = next((value for value in values if value["kind"] == "unknown"), None)
        if unknown is not None:
            return unknown
        values = [value for value in values if value["kind"] != "never"]
        if not values:
            return self.never()
        if all(value["kind"] == "literal" for value in values):
            bases = {value["base"] for value in values}
            if len(bases) == 1:
                unique = []
                seen = set()
                for value in values:
                    marker = repr(value["value"])
                    if marker not in seen:
                        seen.add(marker)
                        unique.append(marker)
                if unique == ["None"]:
                    return self.literal(None)
                return {
                    "kind": "type",
                    "display": f"Literal[{', '.join(unique)}]",
                }
        displays = []
        for value in values:
            display = value["display"]
            if display not in displays:
                displays.append(display)
        if len(displays) == 1:
            descriptor_paths = [value.get("descriptorPath") for value in values]
            descriptor_path = descriptor_paths[0] if descriptor_paths and descriptor_paths[0] is not None else None
            if descriptor_path is not None and all(
                path is not None and descriptor_key(path) == descriptor_key(descriptor_path)
                for path in descriptor_paths
            ):
                return self.type_value(displays[0], descriptor_path)
            return self.type_value(displays[0])
        return self.type_value(" | ".join(displays))

    def function_for_name(self, scope_path, name):
        for length in range(len(scope_path), -1, -1):
            paths = self.functions_by_scope.get((descriptor_key(scope_path[:length]), name), [])
            if len(paths) == 1:
                return paths[0]
            if len(paths) > 1:
                return None
        return None

    def eval_expr(self, node, environment, scope_path, stack, depth):
        if depth >= self.MAX_DEPTH:
            return self.unknown("RecursionLimit", "type inference reached its depth limit")
        if isinstance(node, ast.Constant):
            return self.literal(node.value)
        if isinstance(node, ast.Name):
            return environment.get(node.id, self.unknown(detail=f"type of {node.id} is not inferred"))
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            value = self.eval_expr(node.operand, environment, scope_path, stack, depth + 1)
            if value["kind"] == "literal" and isinstance(value["value"], (int, float)) and not isinstance(
                value["value"], bool
            ):
                amount = value["value"] if isinstance(node.op, ast.UAdd) else -value["value"]
                return self.literal(amount)
            return value if value["kind"] == "unknown" else self.unknown(detail="unary expression is not inferred")
        if isinstance(node, ast.BinOp):
            left = self.eval_expr(node.left, environment, scope_path, stack, depth + 1)
            right = self.eval_expr(node.right, environment, scope_path, stack, depth + 1)
            if left["kind"] == "unknown":
                return left
            if right["kind"] == "unknown":
                return right
            if left["kind"] == "literal" and right["kind"] == "literal":
                operations = {
                    ast.Add: operator.add,
                    ast.Sub: operator.sub,
                    ast.Mult: operator.mul,
                    ast.Div: operator.truediv,
                    ast.FloorDiv: operator.floordiv,
                    ast.Mod: operator.mod,
                }
                operation = next((function for kind, function in operations.items() if isinstance(node.op, kind)), None)
                if operation is not None:
                    try:
                        return self.literal(operation(left["value"], right["value"]))
                    except (ArithmeticError, TypeError):
                        pass
            return self.unknown(detail="binary expression is not inferred")
        if isinstance(node, ast.IfExp):
            return self.join(
                [
                    self.eval_expr(node.body, environment, scope_path, stack, depth + 1),
                    self.eval_expr(node.orelse, environment, scope_path, stack, depth + 1),
                ]
            )
        if isinstance(node, ast.List):
            return self.type_value("list")
        if isinstance(node, ast.Dict):
            return self.type_value("dict")
        if isinstance(node, ast.Set):
            return self.type_value("set")
        if isinstance(node, ast.Tuple):
            return self.type_value("tuple")
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            class_binding = self.analyzer.binding_for(
                node.func.id,
                "typeUse",
                scope_path,
                self.analyzer.range_of(node.func)["start"],
            )
            if class_binding.get("status") == "bound":
                return self.type_value(node.func.id, class_binding["descriptorPath"])
            target = self.function_for_name(scope_path, node.func.id)
            if target is not None:
                target_key = descriptor_key(target)
                if target_key in stack:
                    return self.unknown("RecursionLimit", "recursive return inference reached its limit")
                return self.infer_function(target, stack, depth + 1)
        if isinstance(node, ast.JoinedStr):
            return self.type_value("str")
        return self.unknown(detail="expression type is not inferred")

    def statement_nodes(self, statements):
        for node in statements:
            yield node
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                continue
            for nested in self.analyzer.nested_statements(node):
                yield from self.statement_nodes(nested)

    def function_environment(self, node, scope_path, stack, depth):
        environment = {}
        arguments = [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs]
        if node.args.vararg is not None:
            arguments.append(node.args.vararg)
        if node.args.kwarg is not None:
            arguments.append(node.args.kwarg)
        for argument in arguments:
            environment[argument.arg] = self.unknown(detail=f"parameter {argument.arg} has no inferred type")
        for statement in self.statement_nodes(node.body):
            if isinstance(statement, ast.Assign):
                value = self.eval_expr(statement.value, environment, scope_path, stack, depth + 1)
                for target in statement.targets:
                    for name in names_in_target(target):
                        environment[name.id] = value
            elif isinstance(statement, ast.AnnAssign) and statement.value is not None:
                value = self.eval_expr(statement.value, environment, scope_path, stack, depth + 1)
                for name in names_in_target(statement.target):
                    environment[name.id] = value
            elif isinstance(statement, ast.NamedExpr):
                value = self.eval_expr(statement.value, environment, scope_path, stack, depth + 1)
                for name in names_in_target(statement.target):
                    environment[name.id] = value
            elif isinstance(statement, ast.AugAssign):
                for name in names_in_target(statement.target):
                    environment[name.id] = self.unknown(detail=f"augmented assignment to {name.id} is not inferred")
        return environment

    def is_sys_exit(self, node):
        return (
            isinstance(node, ast.Expr)
            and isinstance(node.value, ast.Call)
            and isinstance(node.value.func, ast.Attribute)
            and isinstance(node.value.func.value, ast.Name)
            and node.value.func.value.id == "sys"
            and node.value.func.attr == "exit"
        )

    def statement_can_fall_through(self, node):
        if isinstance(node, (ast.Return, ast.Raise)) or self.is_sys_exit(node):
            return False
        if isinstance(node, ast.If):
            if not node.orelse:
                return True
            return self.statements_can_fall_through(node.body) or self.statements_can_fall_through(node.orelse)
        if isinstance(node, ast.Match):
            if not node.cases:
                return True
            return True
        if isinstance(node, ast.Try):
            if node.finalbody and not self.statements_can_fall_through(node.finalbody):
                return False
            return True
        return True

    def statements_can_fall_through(self, statements):
        for node in statements:
            if not self.statement_can_fall_through(node):
                return False
        return True

    def infer_function(self, path, stack, depth):
        key = descriptor_key(path)
        if key in self.memo:
            return self.memo[key]
        if key in stack or depth >= self.MAX_DEPTH:
            return self.unknown("RecursionLimit", "recursive return inference reached its limit")
        item = self.function_nodes.get(key)
        if item is None:
            return self.unknown(detail="function declaration is not indexed")
        _, node = item
        collector = ReturnCollector()
        for statement in node.body:
            collector.visit(statement)
        if collector.has_yield:
            result = self.unknown("NotImplemented", "generator return inference is not implemented")
            self.memo[key] = result
            return result
        environment = self.function_environment(node, path, [*stack, key], depth + 1)
        values = []
        for return_node in collector.returns:
            if return_node.value is None:
                values.append(self.literal(None))
            else:
                values.append(self.eval_expr(return_node.value, environment, path, [*stack, key], depth + 1))
        falls_through = self.statements_can_fall_through(node.body)
        if falls_through:
            values.append(self.literal(None))
        result = self.join(values)
        self.function_bases[key] = self.return_basis(len(collector.returns), falls_through, result)
        self.memo[key] = result
        return result

    def return_basis(self, count, falls_through, result):
        if result["kind"] == "never":
            return "non-returning function"
        if count == 0:
            return "implicit None"
        noun = "return statement" if count == 1 else "return statements"
        if falls_through:
            return f"{count} {noun} and implicit None"
        return f"{count} {noun}"

    def initializer_value(self, node):
        if isinstance(node, ast.Assign):
            return node.value
        if isinstance(node, ast.AnnAssign):
            return node.value
        if isinstance(node, ast.NamedExpr):
            return node.value
        return None

    def infer_declaration(self, path, raw):
        key = descriptor_key(path)
        nodes = self.analyzer.declaration_nodes.get(key, [])
        node = nodes[-1] if nodes else None
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            result = self.infer_function(path, [], 0)
            return result, self.function_bases.get(key, "return statements")
        if node is None:
            return self.unknown(detail="declaration initializer is not indexed"), None
        value = self.initializer_value(node)
        if value is None:
            if isinstance(node, ast.ClassDef):
                return self.unknown(detail="class type inference is not implemented"), None
            return self.unknown(detail="initializer type is not inferred"), None
        result = self.eval_expr(value, {}, path[:-1], [], 0)
        return result, "initializer"

    def encoded(self, path, result, basis):
        answer = {"descriptorPath": path}
        if result["kind"] == "unknown":
            answer["reason"] = result["reason"]
            answer["detail"] = result["detail"]
        else:
            answer["display"] = "Never" if result["kind"] == "never" else result["display"]
            answer["basis"] = basis or "inference"
            if result.get("descriptorPath") is not None:
                answer["typeDescriptorPath"] = result["descriptorPath"]
        return answer

    def run(self):
        answers = []
        for raw in self.analyzer.declarations.values():
            if "typeText" in raw:
                continue
            path = raw["descriptorPath"]
            result, basis = self.infer_declaration(path, raw)
            answers.append(self.encoded(path, result, basis))
        return answers


def type_comment_expressions(text):
    if not text:
        return []
    parts = [text]
    stripped = text.strip()
    if stripped.startswith("(") and "->" in stripped:
        arguments, returns = stripped.split("->", 1)
        parts = [arguments.strip(), returns.strip()]
    expressions = []
    for part in parts:
        try:
            expressions.append(ast.parse(part, mode="eval").body)
        except SyntaxError:
            return []
    return expressions


class ReferenceVisitor(ast.NodeVisitor):
    def __init__(self, analyzer):
        self.analyzer = analyzer
        self.scope_path = []
        self.scope_kind = "module"
        self.binding_blocked = None

    def add_reference(self, node, role, name=None, range_node=None, range_value=None, bindable=True):
        if name is None:
            name = node.id if isinstance(node, ast.Name) else node.attr
        reference_range = range_value or self.analyzer.reference_range(range_node or node)
        self.analyzer.references.append(
            {
                "name": name,
                "range": reference_range,
                "role": role,
                "scopePath": list(self.scope_path),
                "binding": self.analyzer.binding_for(
                    name, role, self.scope_path, reference_range["start"], bindable, self.binding_blocked
                ),
            }
        )

    def add_named_reference(self, node, name, role):
        self.add_reference(node, role, name=name, range_value=self.analyzer.selection_of(node, name))

    def visit_ClassDef(self, node):
        self.visit_decorators_and_bases(node)
        old_path = self.scope_path
        old_kind = self.scope_kind
        self.scope_path = old_path + [descriptor("type", node.name)]
        self.scope_kind = "class"
        for child in node.body:
            self.visit(child)
        self.scope_path = old_path
        self.scope_kind = old_kind

    def visit_FunctionDef(self, node):
        self.visit_function_header(node)
        old_path = self.scope_path
        old_kind = self.scope_kind
        self.scope_path = old_path + [descriptor("method", node.name)]
        self.scope_kind = "function"
        for child in node.body:
            self.visit(child)
        self.scope_path = old_path
        self.scope_kind = old_kind

    def visit_AsyncFunctionDef(self, node):
        self.visit_FunctionDef(node)

    def visit_decorators_and_bases(self, node):
        for decorator in node.decorator_list:
            self.visit(decorator)
        for base in node.bases:
            self.visit_class_base(base)
        for keyword in node.keywords:
            self.visit(keyword.value)

    def visit_class_base(self, node):
        if isinstance(node, ast.Name):
            self.add_reference(node, "extends")
        elif isinstance(node, ast.Attribute):
            self.visit(node.value)
            self.add_reference(node, "extends", bindable=False)
        elif isinstance(node, ast.Subscript):
            self.visit_class_base(node.value)
            self.visit(node.slice)
        else:
            self.visit(node)

    def visit_function_header(self, node):
        for decorator in node.decorator_list:
            self.visit(decorator)
        arguments = node.args
        for default in [*arguments.defaults, *arguments.kw_defaults]:
            if default is not None:
                self.visit(default)
        for argument in [*arguments.posonlyargs, *arguments.args, *arguments.kwonlyargs]:
            if argument.annotation is not None:
                self.visit_type_expression(argument.annotation)
            self.visit_type_comment(getattr(argument, "type_comment", None), argument)
        if arguments.vararg and arguments.vararg.annotation is not None:
            self.visit_type_expression(arguments.vararg.annotation)
        if arguments.vararg:
            self.visit_type_comment(getattr(arguments.vararg, "type_comment", None), arguments.vararg)
        if arguments.kwarg and arguments.kwarg.annotation is not None:
            self.visit_type_expression(arguments.kwarg.annotation)
        if arguments.kwarg:
            self.visit_type_comment(getattr(arguments.kwarg, "type_comment", None), arguments.kwarg)
        if node.returns is not None:
            self.visit_type_expression(node.returns)
        self.visit_type_comment(getattr(node, "type_comment", None), node)

    def visit_type_comment(self, text, anchor):
        for expression in type_comment_expressions(text):
            self.visit_type_expression(expression, anchor)

    def visit_type_expression(self, node, anchor=None):
        if isinstance(node, ast.Name):
            self.add_reference(node, "typeUse", range_node=anchor)
            return
        if isinstance(node, ast.Attribute):
            self.visit_type_expression(node.value, anchor)
            self.add_reference(node, "typeUse", range_node=anchor or node, bindable=False)
            return
        for child in ast.iter_child_nodes(node):
            self.visit_type_expression(child, anchor)

    def visit_arg(self, node):
        if node.annotation is not None:
            self.visit_type_expression(node.annotation)
        self.visit_type_comment(getattr(node, "type_comment", None), node)

    def visit_Name(self, node):
        if node.id == "__all__":
            return
        if isinstance(node.ctx, ast.Load):
            self.add_reference(node, "read")
        elif isinstance(node.ctx, ast.Store):
            self.add_reference(node, "write")

    def visit_Attribute(self, node):
        self.visit(node.value)
        if isinstance(node.ctx, ast.Load):
            self.add_reference(node, "read", bindable=False)
        elif isinstance(node.ctx, ast.Store):
            self.add_reference(node, "write", bindable=False)

    def visit_augmented_target(self, node):
        if isinstance(node, ast.Name):
            if node.id != "__all__":
                self.add_reference(node, "read")
                self.add_reference(node, "write")
        elif isinstance(node, ast.Attribute):
            self.visit(node.value)
            self.add_reference(node, "read", bindable=False)
            self.add_reference(node, "write", bindable=False)
        elif isinstance(node, (ast.Tuple, ast.List)):
            for element in node.elts:
                self.visit_augmented_target(element)
        elif isinstance(node, ast.Starred):
            self.visit_augmented_target(node.value)
        elif isinstance(node, ast.Subscript):
            self.visit(node.value)
            self.visit(node.slice)
        else:
            self.visit(node)

    def visit_AugAssign(self, node):
        self.visit_augmented_target(node.target)
        self.visit(node.value)

    def visit_AnnAssign(self, node):
        self.visit(node.target)
        self.visit_type_expression(node.annotation)
        if node.value is not None:
            self.visit(node.value)

    def visit_Assign(self, node):
        self.generic_visit(node)
        self.visit_type_comment(getattr(node, "type_comment", None), node)

    def visit_For(self, node):
        self.generic_visit(node)
        self.visit_type_comment(getattr(node, "type_comment", None), node)

    def visit_AsyncFor(self, node):
        self.visit_For(node)

    def visit_With(self, node):
        self.generic_visit(node)
        self.visit_type_comment(getattr(node, "type_comment", None), node)

    def visit_AsyncWith(self, node):
        self.visit_With(node)

    def visit_Lambda(self, node):
        old_blocked = self.binding_blocked
        self.binding_blocked = "lambda scope is not indexed"
        self.generic_visit(node)
        self.binding_blocked = old_blocked

    def visit_comprehension_scope(self, node):
        old_blocked = self.binding_blocked
        self.binding_blocked = "comprehension scope is not indexed"
        self.generic_visit(node)
        self.binding_blocked = old_blocked

    def visit_ListComp(self, node):
        self.visit_comprehension_scope(node)

    def visit_SetComp(self, node):
        self.visit_comprehension_scope(node)

    def visit_DictComp(self, node):
        self.visit_comprehension_scope(node)

    def visit_GeneratorExp(self, node):
        self.visit_comprehension_scope(node)

    def visit_ExceptHandler(self, node):
        if node.type is not None:
            self.visit(node.type)
        if node.name is not None:
            self.add_named_reference(node, node.name, "write")
        for statement in node.body:
            self.visit(statement)

    def visit_MatchAs(self, node):
        if node.pattern is not None:
            self.visit(node.pattern)
        if node.name is not None:
            self.add_named_reference(node, node.name, "write")

    def visit_MatchStar(self, node):
        if node.name is not None:
            self.add_named_reference(node, node.name, "write")

    def visit_MatchMapping(self, node):
        for key in node.keys:
            self.visit(key)
        for pattern in node.patterns:
            self.visit(pattern)
        if node.rest is not None:
            self.add_named_reference(node, node.rest, "write")

    def visit_Call(self, node):
        if isinstance(node.func, ast.Name):
            self.add_reference(node.func, "call")
        elif isinstance(node.func, ast.Attribute):
            self.visit(node.func.value)
            self.add_reference(node.func, "call", bindable=False)
        else:
            self.visit(node.func)
        for argument in node.args:
            self.visit(argument)
        for keyword in node.keywords:
            self.visit(keyword.value)

    def visit_Import(self, node):
        for alias in node.names:
            local_name = alias.asname or alias.name.split(".")[0]
            imported_name = self.analyzer.imported_name(alias, local_only=True)
            # A local import is a re-export only when __all__ names that local binding.
            self.analyzer.imports.append(
                {
                    "specifier": alias.name,
                    "imported": [] if imported_name is None else [imported_name],
                    "reExport": not self.scope_path and self.analyzer.is_explicitly_exported(local_name),
                }
            )
            self.analyzer.import_bindings.append(
                {
                    "specifier": alias.name,
                    "localName": local_name,
                    "importedName": None,
                    "scopePath": list(self.scope_path),
                    "conditional": self.is_conditional(local_name),
                    "star": False,
                }
            )

    def visit_ImportFrom(self, node):
        specifier = "." * node.level + (node.module or "")
        if specifier == "":
            specifier = "."
        imported = []
        for alias in node.names:
            name = self.analyzer.imported_name(alias)
            if name is not None:
                imported.append(name)
        re_export = self.analyzer.is_from_reexport(node.names, self.scope_path)
        self.analyzer.imports.append({"specifier": specifier, "imported": imported, "reExport": re_export})
        for alias in node.names:
            if alias.name == "*":
                self.analyzer.import_bindings.append(
                    {
                        "specifier": specifier,
                        "localName": "*",
                        "importedName": None,
                        "scopePath": list(self.scope_path),
                        "conditional": self.is_conditional("*"),
                        "star": True,
                    }
                )
                continue
            local_name = alias.asname or alias.name
            self.analyzer.import_bindings.append(
                {
                    "specifier": specifier,
                    "localName": local_name,
                    "importedName": alias.name,
                    "scopePath": list(self.scope_path),
                    "conditional": self.is_conditional(local_name),
                    "star": False,
                }
            )

    def is_conditional(self, name):
        info = self.analyzer.scope_infos.get(descriptor_key(self.scope_path))
        return info is not None and name in info["conditional"]


def all_string_ids(tree):
    found = set()
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Assign, ast.AugAssign)):
            continue
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        if not any(isinstance(target, ast.Name) and target.id == "__all__" for target in targets):
            continue
        value = node.value
        if not isinstance(value, (ast.List, ast.Tuple, ast.Set)):
            continue
        for element in value.elts:
            if isinstance(element, ast.Constant) and isinstance(element.value, str):
                found.add(id(element))
    return found


class RenameVisitor(ast.NodeVisitor):
    def __init__(self, analyzer):
        self.analyzer = analyzer
        self.scope_path = []
        self.unsupported_depth = 0
        self.candidates = []
        self.all_strings = all_string_ids(analyzer.tree)
        self.annotation_ranges = [item["annotationRange"] for item in analyzer.type_annotations]

    def add_candidate(self, name, value_range, kind, binding=False):
        info = self.analyzer.scope_infos.get(descriptor_key(self.scope_path))
        self.candidates.append(
            {
                "name": name,
                "range": value_range,
                "kind": kind,
                "binding": binding,
                "scopePath": list(self.scope_path),
                "dynamic": self.unsupported_depth > 0 or (info is not None and info["dynamic"]),
            }
        )

    def argument_range(self, argument):
        end = argument.col_offset + len(argument.arg.encode("utf-8"))
        return self.analyzer.range_from_columns(argument.lineno, argument.col_offset, end)

    def definition_range(self, node, prefix):
        start = node.col_offset + len(prefix.encode("utf-8"))
        end = start + len(node.name.encode("utf-8"))
        return self.analyzer.range_from_columns(node.lineno, start, end)

    def visit_function(self, node, prefix):
        self.add_candidate(node.name, self.definition_range(node, prefix), "declaration", True)
        for decorator in node.decorator_list:
            self.visit(decorator)
        arguments = node.args
        for default in [*arguments.defaults, *arguments.kw_defaults]:
            if default is not None:
                self.visit(default)
        for argument in [*arguments.posonlyargs, *arguments.args, *arguments.kwonlyargs]:
            if argument.annotation is not None:
                self.visit(argument.annotation)
        for argument in [arguments.vararg, arguments.kwarg]:
            if argument is not None and argument.annotation is not None:
                self.visit(argument.annotation)
        if node.returns is not None:
            self.visit(node.returns)

        old_path = self.scope_path
        self.scope_path = old_path + [descriptor("method", node.name)]
        arguments = [*arguments.posonlyargs, *arguments.args, *arguments.kwonlyargs]
        for argument in arguments:
            self.add_candidate(argument.arg, self.argument_range(argument), "parameter", True)
        if node.args.vararg is not None:
            self.add_candidate(node.args.vararg.arg, self.argument_range(node.args.vararg), "parameter", True)
        if node.args.kwarg is not None:
            self.add_candidate(node.args.kwarg.arg, self.argument_range(node.args.kwarg), "parameter", True)
        for child in node.body:
            self.visit(child)
        self.scope_path = old_path

    def visit_FunctionDef(self, node):
        self.visit_function(node, "def ")

    def visit_AsyncFunctionDef(self, node):
        self.visit_function(node, "async def ")

    def visit_ClassDef(self, node):
        self.add_candidate(node.name, self.definition_range(node, "class "), "declaration", True)
        for decorator in node.decorator_list:
            self.visit(decorator)
        for base in node.bases:
            self.visit(base)
        for keyword_node in node.keywords:
            self.visit(keyword_node.value)
        old_path = self.scope_path
        self.scope_path = old_path + [descriptor("type", node.name)]
        for child in node.body:
            self.visit(child)
        self.scope_path = old_path

    def visit_arg(self, node):
        self.add_candidate(node.arg, self.argument_range(node), "parameter", True)
        if node.annotation is not None:
            self.visit(node.annotation)

    def visit_Name(self, node):
        self.add_candidate(
            node.id,
            self.analyzer.range_of(node),
            "identifier",
            isinstance(node.ctx, (ast.Store, ast.Del)),
        )

    def visit_Attribute(self, node):
        self.visit(node.value)
        end_line = getattr(node, "end_lineno", node.lineno)
        end_column = getattr(node, "end_col_offset", node.col_offset)
        start_column = end_column - len(node.attr.encode("utf-8"))
        self.add_candidate(
            node.attr,
            self.analyzer.range_from_columns(end_line, start_column, end_column),
            "attribute",
        )

    def visit_Import(self, node):
        for alias in node.names:
            imported = self.analyzer.imported_name(alias, local_only=True)
            self.add_candidate(imported["local"], imported["localRange"], "localImport", True)

    def visit_ImportFrom(self, node):
        for alias in node.names:
            imported = self.analyzer.imported_name(alias)
            if imported is None:
                continue
            binds_local = alias.asname is None or alias.asname == alias.name
            self.add_candidate(imported["name"], imported["range"], "sourceImport", binds_local)
            if "local" in imported:
                self.add_candidate(imported["local"], imported["localRange"], "localImport", True)

    def visit_keyword(self, node):
        if node.arg is not None:
            end = node.col_offset + len(node.arg.encode("utf-8"))
            self.add_candidate(
                node.arg,
                self.analyzer.range_from_columns(node.lineno, node.col_offset, end),
                "keyword",
            )
        self.visit(node.value)

    def visit_Lambda(self, node):
        self.unsupported_depth += 1
        self.generic_visit(node)
        self.unsupported_depth -= 1

    def visit_ListComp(self, node):
        self.unsupported_depth += 1
        self.generic_visit(node)
        self.unsupported_depth -= 1

    def visit_SetComp(self, node):
        self.visit_ListComp(node)

    def visit_DictComp(self, node):
        self.visit_ListComp(node)

    def visit_GeneratorExp(self, node):
        self.visit_ListComp(node)

    def visit_Constant(self, node):
        if not isinstance(node.value, str):
            return
        value_range = self.analyzer.range_of(node)
        kind = "stringLiteral"
        if id(node) in self.all_strings:
            kind = "allString"
        elif any(range_contains(annotation_range, value_range) for annotation_range in self.annotation_ranges):
            kind = "stringAnnotation"
        self.add_candidate(node.value, value_range, kind)


def resolve_scope(analyzer, scope_path, name):
    current = list(scope_path)
    while True:
        info = analyzer.scope_infos.get(descriptor_key(current))
        if info is not None:
            if info["kind"] == "function" and name in info["globals"]:
                return []
            if name in info["locals"] or name in info["parameters"]:
                return current
            if name in info["nonlocals"]:
                current = current[:-1]
                if current and current[-1]["kind"] == "type":
                    current = current[:-1]
                continue
        if not current:
            return None
        was_method = current[-1]["kind"] == "method"
        current = current[:-1]
        if was_method and current and current[-1]["kind"] == "type":
            current = current[:-1]


def candidate_matches(candidate, site_range, text, old_name):
    candidate_range = candidate["range"]
    if candidate["kind"] in {"allString", "stringAnnotation", "stringLiteral"}:
        if not range_contains(candidate_range, site_range) and not ranges_equal(candidate_range, site_range):
            return False
        return candidate["name"] == old_name or old_name in text_for_range(text, site_range)
    return candidate["name"] == old_name and (
        ranges_equal(candidate_range, site_range) or range_contains(site_range, candidate_range)
    )


def blocked_site(site, reason, detail):
    return {"range": site["range"], "reason": reason, "detail": detail}


def owner_call_for_range(analyzer, owner_range):
    matches = []
    for node in ast.walk(analyzer.tree):
        if not isinstance(node, ast.Call):
            continue
        call_range = analyzer.range_of(node)
        if range_contains(call_range, owner_range) or range_contains(owner_range, call_range):
            span = (
                call_range["end"]["line"] - call_range["start"]["line"],
                call_range["end"]["character"] - call_range["start"]["character"],
            )
            matches.append((span, call_range, node))
    if not matches:
        return None
    matches.sort(key=lambda item: item[0])
    return matches[0][2]


def rename_edits(module, text, old_name, new_name, sites, owner_calls=None):
    if not old_name.isidentifier() or not new_name.isidentifier():
        return {"status": "refused", "reason": "InvalidName", "detail": "Python names must be identifiers"}
    if keyword.iskeyword(new_name):
        return {"status": "refused", "reason": "ReservedWord", "detail": f"{new_name} is a Python keyword"}
    try:
        tree = ast.parse(text, filename=module, type_comments=True)
    except SyntaxError as error:
        return {"status": "refused", "reason": "ParseError", "detail": f"parse error: {error}"}
    if old_name == new_name:
        return {"status": "ready", "edits": [], "blocked": []}

    analyzer = Analyzer(module, text)
    analyzer.analyze(tree)
    visitor = RenameVisitor(analyzer)
    visitor.visit(tree)

    matched_sites = []
    for site in sites:
        matches = [candidate for candidate in visitor.candidates if candidate_matches(candidate, site["range"], text, old_name)]
        unique = {}
        for candidate in matches:
            unique[(candidate["kind"], range_key(candidate["range"]))] = candidate
        matched_sites.append((site, list(unique.values())))

    parameter_target = owner_calls is not None or any(
        len(matches) == 1 and matches[0]["kind"] == "parameter" for _, matches in matched_sites
    )
    if parameter_target and owner_calls is None:
        return {
            "status": "refused",
            "reason": "NotImplemented",
            "detail": "parameter renames cannot account for keyword callers outside this request",
        }

    parameter_ranges = {
        range_key(matches[0]["range"])
        for _, matches in matched_sites
        if len(matches) == 1 and matches[0]["kind"] == "parameter"
    }
    parameter_accepts_keyword = any(
        range_key(visitor.argument_range(argument)) in parameter_ranges
        for function in ast.walk(analyzer.tree)
        if isinstance(function, (ast.FunctionDef, ast.AsyncFunctionDef))
        for argument in [*function.args.args, *function.args.kwonlyargs]
    )

    owner_edits = []
    owner_blocked = []
    if parameter_target:
        seen_owner_ranges = set()
        for owner_range in owner_calls or []:
            owner_key = range_key(owner_range)
            if owner_key in seen_owner_ranges:
                continue
            seen_owner_ranges.add(owner_key)
            call = owner_call_for_range(analyzer, owner_range)
            if call is None:
                owner_blocked.append(
                    blocked_site(
                        {"range": owner_range},
                        "NotImplemented",
                        "the supplied owner range does not enclose a call",
                    )
                )
                continue
            if parameter_accepts_keyword and any(keyword_node.arg is None for keyword_node in call.keywords):
                owner_blocked.append(
                    blocked_site(
                        {"range": owner_range},
                        "NotImplemented",
                        "the call forwards keyword names through **kwargs",
                    )
                )
                continue
            for keyword_node in call.keywords:
                if keyword_node.arg == old_name:
                    owner_edits.append(
                        {
                            "site": {"range": owner_range},
                            "edit": {"range": visitor.argument_range(keyword_node), "newText": new_name},
                        }
                    )

    target_scopes = {}
    for _, matches in matched_sites:
        if len(matches) != 1:
            continue
        candidate = matches[0]
        if candidate["binding"]:
            scope = candidate["scopePath"]
        else:
            scope = resolve_scope(analyzer, candidate["scopePath"], old_name)
        if scope is not None:
            target_scopes[descriptor_key(scope)] = scope

    for scope_key, scope in target_scopes.items():
        info = analyzer.scope_infos.get(scope_key)
        if info is None:
            continue
        if new_name in info["locals"] or new_name in info["parameters"]:
            return {
                "status": "refused",
                "reason": "Collision",
                "detail": f"{new_name} already binds in the target scope",
            }

    edits_by_key = {}
    blocked_by_site = {}
    for index, (site, matches) in enumerate(matched_sites):
        if len(matches) == 0:
            if text_for_range(text, site["range"]) == new_name:
                continue
            blocked_by_site[index] = blocked_site(
                site,
                "NotImplemented",
                "the supplied range does not match a supported Python rename site",
            )
            continue
        if len(matches) != 1:
            blocked_by_site[index] = blocked_site(
                site,
                "NotImplemented",
                "the supplied range matches multiple Python rename sites",
            )
            continue

        candidate = matches[0]
        kind = candidate["kind"]
        if kind == "allString" and candidate["name"] == old_name:
            edit = {"range": candidate["range"], "newText": repr(new_name)}
        elif kind in {"stringAnnotation", "stringLiteral"}:
            blocked_by_site[index] = blocked_site(
                site,
                "StringLiteral",
                "renaming inside a string could change unrelated text",
            )
            continue
        elif kind == "attribute":
            blocked_by_site[index] = blocked_site(
                site,
                "NotImplemented",
                "attribute names may be created or read dynamically",
            )
            continue
        elif kind == "keyword":
            blocked_by_site[index] = blocked_site(
                site,
                "NotImplemented",
                "keyword argument names are not a closed reference set",
            )
            continue
        elif candidate["dynamic"]:
            blocked_by_site[index] = blocked_site(
                site,
                "NotImplemented",
                "exec or eval can change this scope",
            )
            continue
        else:
            edit = {"range": candidate["range"], "newText": new_name}

        key = (range_key(edit["range"]), edit["newText"])
        group = edits_by_key.setdefault(key, {"edit": edit, "sources": []})
        group["sources"].append(("site", index))

    for owner_index, owner_edit in enumerate(owner_edits):
        edit = owner_edit["edit"]
        key = (range_key(edit["range"]), edit["newText"])
        group = edits_by_key.setdefault(key, {"edit": edit, "sources": []})
        group["sources"].append(("owner", owner_index))

    groups = sorted(edits_by_key.values(), key=lambda item: range_key(item["edit"]["range"]))
    overlapping_groups = set()
    for left_index, left in enumerate(groups):
        for right_index in range(left_index + 1, len(groups)):
            right = groups[right_index]
            if ranges_overlap(left["edit"]["range"], right["edit"]["range"]):
                overlapping_groups.add(left_index)
                overlapping_groups.add(right_index)
    for group_index in overlapping_groups:
        group = groups[group_index]
        for source_kind, source_index in group["sources"]:
            if source_kind == "site":
                blocked_by_site[source_index] = blocked_site(
                    matched_sites[source_index][0],
                    "NotImplemented",
                    "the requested edits overlap",
                )
            else:
                owner_blocked.append(
                    blocked_site(
                        owner_edits[source_index]["site"],
                        "NotImplemented",
                        "the requested edits overlap",
                    )
                )

    edits = [group["edit"] for index, group in enumerate(groups) if index not in overlapping_groups]
    blocked = [blocked_by_site[index] for index in sorted(blocked_by_site)] + owner_blocked
    return {"status": "ready", "edits": edits, "blocked": blocked}


# //////// Entry point

def extract(module, text):
    try:
        tree = ast.parse(text, filename=module, type_comments=True)
    except SyntaxError as error:
        return {
            "declarations": [],
            "references": [],
            "imports": [],
            "importBindings": [],
            "scopeInfos": [],
            "typeAnnotations": [],
            "inferredTypes": [],
            "literals": [],
            "diagnostics": [diagnostic(f"parse error: {error}")],
        }
    return Analyzer(module, text).analyze(tree)


def main():
    request = json.load(sys.stdin)
    if request.get("mode") == "rename":
        result = rename_edits(
            request["module"],
            request["text"],
            request["oldName"],
            request["newName"],
            request["sites"],
            request.get("ownerCalls"),
        )
    else:
        result = extract(request["module"], request["text"])
    json.dump(result, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
