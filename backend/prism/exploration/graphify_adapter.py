"""The only private Graphify seam; pinned and tested against 0.9.86.

Read syntax/configuration and module-binding facts without executing target code
or reading mutable worktrees. Prism's existing committed-source resolver supplies
relative/manifest aliases. Enrichment adds scopes, owned fields and composition.
"""
from functools import lru_cache
from importlib import import_module
from importlib.metadata import version
from dataclasses import replace
from pathlib import Path
import inspect
import ast
import textwrap
import re
import threading
import tempfile
from tree_sitter import Language, Parser

extraction_lock = threading.RLock()  # Graphify's resolver caches are process-global.


def registry():
    """Use Graphify's dispatch, including custom/regex providers, as authority."""
    from graphify import extract
    return dict(extract._DISPATCH)


def provider_config(name,extension):
    from graphify import extract
    provider=next((fn for fn in registry().values() if fn.__name__==name),None) or getattr(extract,name,None)
    return grammar_config(provider,extension) if provider else None


def grammar_config(extractor, extension):
    from graphify import extract
    from graphify.extractors.models import LanguageConfig
    try:source = inspect.getsource(extractor)
    except (OSError,TypeError):return None
    configs = [extractor.__globals__[name] for name in extractor.__code__.co_names
               if isinstance(extractor.__globals__.get(name), LanguageConfig)]
    if extractor is extract.extract_js:
        return extract._TSX_CONFIG if extension == '.tsx' else extract._TS_CONFIG if extension in {'.ts','.mts','.cts'} else extract._JS_CONFIG
    if len(configs) == 1: return configs[0]
    primary=re.search(r'_extract_generic\([^,]+,\s*(\w+_CONFIG)\b',source)
    if primary and isinstance(extractor.__globals__.get(primary[1]),LanguageConfig):return extractor.__globals__[primary[1]]
    # Custom Graphify walks still supply their grammar. Discover it from their
    # own import, rather than keeping a second extension-to-parser registry.
    modules = set(re.findall(r'(?:import|from)\s+(tree_sitter_\w+)', source))
    if len(modules) != 1: return None
    module = modules.pop()
    if module=='tree_sitter_language_pack':
        names=set(re.findall(r'get_(?:parser|language)\([\"\']([^\"\']+)[\"\']\)',source))
        return LanguageConfig(ts_module=module,ts_language_fn='get_language:'+names.pop()) if len(names)==1 else None
    factories=set()
    class Factories(ast.NodeVisitor):
        def visit_If(self,node):
            condition=node.test
            if isinstance(condition,ast.Compare) and len(condition.ops)==1 and isinstance(condition.left,ast.Attribute) and condition.left.attr=='suffix':
                try:other=ast.literal_eval(condition.comparators[0])
                except (ValueError,TypeError):other=None
                op=condition.ops[0]
                if other is not None and isinstance(op,(ast.Eq,ast.NotEq,ast.In,ast.NotIn)):
                    selected=extension==other if isinstance(op,ast.Eq) else extension!=other if isinstance(op,ast.NotEq) else extension in other if isinstance(op,ast.In) else extension not in other
                    for child in node.body if selected else node.orelse:self.visit(child)
                    return
            self.generic_visit(node)
        def visit_Call(self,node):
            if isinstance(node.func,ast.Name) and node.func.id=='Language' and node.args:
                call=node.args[0]
                if isinstance(call,ast.Call) and isinstance(call.func,ast.Attribute) and call.func.attr.startswith('language'):factories.add(call.func.attr)
            self.generic_visit(node)
    Factories().visit(ast.parse(textwrap.dedent(source)))
    if len(factories)>1:return None  # Native facts remain available; never guess a dialect.
    return LanguageConfig(ts_module=module,ts_language_fn=factories.pop() if factories else 'language')


@lru_cache(maxsize=None)
def grammar(module, function):
    if function.startswith('get_language:'):return import_module(module).get_language(function.split(':',1)[1])
    return Language(getattr(import_module(module), function)())


def generic_config(config):
    lang = grammar(config.ts_module, config.ts_language_fn)
    kinds = {lang.node_kind_for_id(i) for i in range(lang.node_kind_count) if lang.node_kind_is_named(i)}
    return replace(config,
        class_types=config.class_types | {k for k in kinds if re.fullmatch(r'(class|struct|enum|trait|interface|protocol|union|type)_(definition|declaration|item|specifier|spec)', k)},
        function_types=config.function_types | {k for k in kinds if re.fullmatch(r'(function|method|constructor)_(definition|declaration|item)', k)},
        import_types=config.import_types | {k for k in kinds if re.fullmatch(r'(import|use|using)_(declaration|statement|directive|spec|header)', k)},
        call_types=config.call_types | {k for k in kinds if re.fullmatch(r'(call|method_invocation|function_call|object_creation|new)(_expression)?', k)})

@lru_cache(maxsize=1)
def configurations():
    if version('graphifyy') != '0.9.86':
        raise RuntimeError('Symbol exploration requires the pinned Graphify 0.9.86 adapter. Run setup.sh.')
    from graphify import extract
    return {ext: grammar_config(provider, ext) for ext, provider in registry().items()}


def parse(source: bytes, extension: str, provider_name=None):
    if provider_name:
        config=provider_config(provider_name,extension)
    else:config = configurations().get(extension)
    if config is None: return None, None
    lang = grammar(config.ts_module, config.ts_language_fn)
    return Parser(lang).parse(source), config


def native_extract(sources):
    """Materialize only committed blobs; run every native dispatch/resolver.

    The temporary tree also contains manifests and unchanged source used by
    Graphify's path resolvers. No target project is imported or run. All native
    nodes/edges keep source provenance until normalization into Prism facts.
    """
    from graphify import extract
    with extraction_lock, tempfile.TemporaryDirectory(prefix='prism-graphify-') as tmp:
        root = Path(tmp)
        for path, source in sources.items():
            dest = root / path
            if not Path(path).is_absolute() and dest.is_relative_to(root) and '..' not in Path(path).parts:
                dest.parent.mkdir(parents=True, exist_ok=True); dest.write_text(source)
        paths = [root / path for path in sources if extract._get_extractor(root / path) is not None]
        graph = extract.extract(paths, root=root, cache_root=root / '.prism-cache', parallel=False)
        errors = {}
        for path in graph.get('failed_sources', []):
            candidate = Path(path) if Path(path).is_absolute() else root / path
            provider = extract._get_extractor(candidate)
            result = extract._safe_extract_with_xaml_root(provider, candidate, root) if provider else {}
            if result.get('error'):
                errors[candidate.relative_to(root).as_posix()] = str(result['error'])
        # Filename/shebang dispatch is as important as suffix dispatch.
        providers = {p.relative_to(root).as_posix(): extract._get_extractor(p).__name__ for p in paths}
        for collection in ('nodes','edges'):
            for item in graph[collection]:
                for key in ('source_file','target_file','definition_file'):
                    if item.get(key):
                        p=Path(item[key])
                        if p.is_absolute():
                            try: item[key]=p.relative_to(root).as_posix()
                            except ValueError: item[key]=''  # Never expose host/worktree sources.
        return graph, providers, errors


def module_facts(node, source):
    from graphify.extractors import resolution as r
    if node.type in {'import_statement', 'export_statement'} and node.child_by_field_name('source'):
        return {'module': r._js_module_specifier(node, source),
                'names': r._js_named_specifiers(node, source, 'import_specifier' if node.type == 'import_statement' else 'export_specifier'),
                'default': r._js_default_import_name(node, source),
                'namespace_export': r._js_namespace_export_name(node, source),
                'star': r._js_export_statement_is_star(node)}
    if node.type == 'import_from_statement':
        module = r._python_import_from_module(node, source)
        return {'module': '.' * module[0] + module[1] if module else '',
                'names': r._python_imported_names(node, source), 'star': any(c.type == 'wildcard_import' for c in node.children)}
    if node.type == 'import_statement':
        return {'module': '', 'names': r._python_imported_names(node, source), 'star': False}
    return None
