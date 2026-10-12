export type NodeStatus='modified'|'added'|'deleted'|'renamed'|'context'
export type GraphLayout='network'|'tree'|'roles'
export interface GraphNode {id:string;label:string;qualified?:string;kind:string;status:NodeStatus;path:string;line:number;end?:number}
export interface GraphEdge {source:string;target:string;relation:string;confidence:string;status?:'added'|'removed'|'unchanged'}
export interface GraphData {nodes:GraphNode[];edges:GraphEdge[];truncated:boolean}
export interface ChangeGroup {id:string;title:string;changed_count:number;files:string[];changed_ids:string[];graph:GraphData}
export interface DiffFile {path:string;old_path:string;status:string;patch:string;new_ranges:number[][];old_ranges:number[][]}
export interface ReviewStep {path:string;reason:string}
export interface AIChange {symbol_id:string;diff_summary?:string;why:string;how_it_works:string;snippet_explanation:string}
export interface AIGroup {id:string;summary:string;before_after:string;impact:string;risks:string[];tests:string[];review_order?:ReviewStep[];changes?:AIChange[]}
export interface AIReport {harness:string;model:string;effort:string;overview:string;key_changes:string[];review_order?:ReviewStep[];schema_version?:number;groups:AIGroup[]}
export interface Report {id:string;demo:boolean;created_at:string;meta:{owner:string;repo:string;number:number;title:string;body:string;url:string;author:string;head:string};stats:{changed_files:number;changed_symbols:number;groups:number;indexed_files:number;total_graph_nodes:number;total_graph_edges:number};files:DiffFile[];groups:ChangeGroup[];overview:GraphData;evidence?:Record<string,{path:string;start_line:number;end_line:number;language:string;side:string;code:string;truncated:boolean}>;ai:AIReport|null}
export interface Job {id:string;kind:string;state:'queued'|'running'|'completed'|'failed';message:string;report_id:string|null;error:string|null}
export interface HarnessInfo {installed:boolean;models:{id:string;label:string;efforts:string[];default_effort:string;is_default:boolean}[];aliases?:string[];efforts?:string[];discovery:string}
export interface Harnesses {claude:HarnessInfo;codex:HarnessInfo}
