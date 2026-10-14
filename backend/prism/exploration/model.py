"""Language-independent facts. Field contexts survive imports and object wrapping."""
from __future__ import annotations
from dataclasses import dataclass, field, asdict
import hashlib

SCHEMA = 2
ADAPTER_VERSION = "graphify-0.9.86-registry-composition-11"


def identity(*parts) -> str:
    return hashlib.sha256(repr(parts).encode()).hexdigest()[:24]


@dataclass(frozen=True)
class Ref:
    entity: str
    fields: tuple[str, ...] = ()

    def child(self, name: str) -> Ref:
        return Ref(self.entity, (*self.fields, name))


@dataclass
class Entity:
    id: str
    name: str
    kind: str
    anchor: dict
    scope: str
    owner: str | None = None
    type_name: str | None = None
    imported: bool = False


@dataclass
class Relationship:
    id: str
    source: Ref
    target: Ref | None
    kind: str
    anchor: dict
    reason: str = ""
    boundary_direction: str = "consumers"


@dataclass
class Facts:
    revision: str
    sources: dict[str, str]
    entities: dict[str, Entity] = field(default_factory=dict)
    fields: dict[Ref, dict] = field(default_factory=dict)
    types: dict[Ref, str] = field(default_factory=dict)
    occurrences: dict[str, list[dict]] = field(default_factory=dict)
    relationships: list[Relationship] = field(default_factory=list)
    coverage: dict = field(default_factory=dict)
    _lines: dict = field(default_factory=dict, repr=False)
    _identities: dict = field(default_factory=dict, repr=False)

    def anchor(self, path, node) -> dict:
        if path not in self._lines: self._lines[path]=self.sources[path].encode().split(b'\n')
        def column(point):
            line = self._lines[path][point.row]
            return len(line[:point.column].decode().encode('utf-16-le')) // 2
        return {"revision": self.revision, "path": path, "start_byte": node.start_byte,
                "end_byte": node.end_byte, "line": node.start_point.row + 1,
                "column": column(node.start_point), "end_line": node.end_point.row + 1,
                "end_column": column(node.end_point)}

    def add(self, source: Ref, target: Ref | None, kind: str, anchor: dict, reason="", boundary_direction="consumers"):
        rid = identity(source, target, kind, anchor['path'], anchor['start_byte'], reason, boundary_direction)
        rel=Relationship(rid, source, target, kind, anchor, reason, boundary_direction)
        self.relationships.append(rel)
        if target and kind in {'identity','import','wrapping','namespace'}:
            self._identities.setdefault(target.entity,[]).append(rel)

    def dump(self) -> dict:
        return {"schema": SCHEMA, "revision": self.revision, "sources": self.sources,
                "entities": {key: asdict(e) for key, e in self.entities.items()},
                "fields": [{"ref": asdict(r), "anchor": a} for r, a in self.fields.items()],
                "types": [{"ref":asdict(r),"entity":e} for r,e in self.types.items()],
                "occurrences": self.occurrences, "relationships": [asdict(r) for r in self.relationships],
                "coverage": self.coverage}

    @classmethod
    def restore(cls, data):
        def ref(r): return Ref(r['entity'], tuple(r['fields']))
        facts = cls(data['revision'], data['sources'])
        facts.entities = {key: Entity(**e) for key, e in data['entities'].items()}
        facts.fields = {ref(item['ref']): item['anchor'] for item in data['fields']}
        facts.types = {ref(item['ref']):item['entity'] for item in data.get('types',[])}
        facts.occurrences = data['occurrences']
        facts.relationships = [Relationship(r['id'], ref(r['source']), ref(r['target']) if r['target'] else None,
                                             r['kind'], r['anchor'], r['reason'], r.get('boundary_direction','consumers')) for r in data['relationships']]
        facts.coverage = data['coverage']
        return facts
