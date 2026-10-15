export type NodeStatus='modified'|'added'|'deleted'|'renamed'|'context'
export interface GraphNode {id:string;label:string;qualified?:string;kind:string;status:NodeStatus;path:string;line:number;end?:number}
export interface GraphEdge {source:string;target:string;relation:string;confidence:string;status?:'added'|'removed'|'unchanged'}
export interface GraphData {nodes:GraphNode[];edges:GraphEdge[];truncated:boolean}
export interface ChangeGroup {id:string;title:string;changed_count:number;files:string[];changed_ids:string[];graph:GraphData}
export interface DiffFile {path:string;old_path:string;status:string;patch:string;new_ranges:number[][];old_ranges:number[][];patch_truncated?:boolean}
export interface ReviewStep {path:string;reason:string}
export interface AIChange {symbol_id:string;diff_summary?:string;why?:string;review_notes?:string[];how_it_works?:string;snippet_explanation?:string}
export interface AIGroup {id:string;summary:string;before_after:string;impact:string;risks:string[];tests:string[];review_order?:ReviewStep[];changes?:AIChange[]}
export interface TopicConnection {topic_id:string;count:number;kind:'direct'|'shared context'}
export interface ChangeTopic {id:string;title:string;focus?:string;source:'ai'|'paths';group_ids:string[];changed_count:number;files:string[];graph:GraphData;connections:TopicConnection[]}
export interface AIReport {harness:string;model:string;effort:string;overview:string;key_changes:string[];review_order?:ReviewStep[];schema_version?:number;groups:AIGroup[];topics?:ChangeTopic[]}
export interface Report {id:string;demo:boolean;created_at:string;meta:{owner:string;repo:string;number:number;title:string;body:string;url:string;author:string;head:string;merge_base?:string};stats:{changed_files:number;changed_symbols:number;groups:number;indexed_files:number;total_graph_nodes:number;total_graph_edges:number};files:DiffFile[];groups:ChangeGroup[];overview:GraphData;topics?:ChangeTopic[];architecture?:ArchitectureData;evidence?:Record<string,{path:string;start_line:number;end_line:number;language:string;side:string;code:string;truncated:boolean}>;ai:AIReport|null}

export interface SourceAnchor {revision:string;path:string;start_byte:number;end_byte:number;line:number;column:number;end_line:number;end_column:number}
export interface ExplorationRoot {id:string;name:string;kind:string;definition:SourceAnchor;ref:{entity:string;fields:string[]}}
export interface ExplorationNode {id:string;path:string;changed:boolean;symbols:{name:string;anchor:SourceAnchor;entity_id:string}[]}
export interface ExplorationConnection {id:string;source:string;target:string;indirect:boolean;hidden_paths:string[];evidence:{id:string;kind:string;anchor:SourceAnchor}[]}
export interface ExplorationBoundary {id:string;kind:string;reason:string;anchor:SourceAnchor;from:string;hidden:boolean}
export interface ExplorationCoverage {complete:boolean;languages:Record<string,number>;omitted:{path:string|null;reason:string}[];adapter:string}
export interface ExplorationProjection {query_id:string;root:ExplorationRoot;revision:string;side:'old'|'new';direction:'consumers'|'origins';changed_only:boolean;nodes:ExplorationNode[];connections:ExplorationConnection[];boundaries:ExplorationBoundary[];has_more:boolean;status:string;coverage:ExplorationCoverage}
export interface ExplorationResult {status:string;root?:ExplorationRoot;projection?:ExplorationProjection;projections?:Partial<Record<'consumers'|'origins',ExplorationProjection>>;revision?:string;side?:'old'|'new';occurrence?:SourceAnchor;name?:string;reason?:string;message?:string;error?:string}
export interface ExplorationSource {status:string;revision:string;side:'old'|'new';path:string;start_line:number;end_line:number;code:string;anchors:SourceAnchor[];bounded:boolean}
export interface ReviewAssistantSettings {harness:'codex'|'claude';model:string;effort:string}
export interface DiffLineAnchor {path:string;old_lines:number[];new_lines:number[]}
export interface QuestionCitation {symbol_id?:string|null;path:string;line:number;end_line:number;label:string;reason:string;old_lines?:number[];new_lines?:number[]}
export interface QuestionAnswer {answer:string;citations:QuestionCitation[];harness:string;model:string}
export interface ViewedFiles {available:boolean;states:Record<string,'VIEWED'|'UNVIEWED'|'DISMISSED'>;reason?:string}
export interface Job {id:string;kind:string;state:'queued'|'running'|'completed'|'failed';message:string;report_id:string|null;result?:QuestionAnswer|null;error:string|null}
export interface HarnessInfo {installed:boolean;models:{id:string;label:string;efforts:string[];default_effort:string;is_default:boolean}[];aliases?:string[];efforts?:string[];discovery:string}
export interface Harnesses {claude:HarnessInfo;codex:HarnessInfo}
export interface ArchitectureEvidence {path:string;line:number;side:'head'|'base';code:string}
export interface ArchitectureNode {id:string;path:string;label:string;layer:string;rank?:number;status:NodeStatus;available:boolean}
export interface ArchitectureEdge {source:string;target:string;relation:string;confidence:string;detail:string;status:'added'|'removed'|'unchanged'|'unclassified';label?:string;evidence:ArchitectureEvidence[]}
export interface ArchitectureData {version:number;nodes:ArchitectureNode[];edges:ArchitectureEdge[];layers:{id:string;title:string;supporting:boolean;focus?:string;presentation?:'files'|'bundle'}[];notes:string[];omitted_context:number;method?:'source'|'semantic';organizer_version?:number;generation?:{harness:string;model:string;effort:string;head:string;base:string;created_at:string}}
