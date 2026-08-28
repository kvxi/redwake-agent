export interface CodexFunctionCall { type:"function_call"; id?:string; call_id:string; name:string; arguments:string; }
export interface CodexMessage { type:"message"; id?:string; role?:string; content?:unknown; }
export type CodexOutputItem = CodexFunctionCall | CodexMessage | Record<string, unknown>;
export interface CodexUsage { inputTokens?:number; outputTokens?:number; totalTokens?:number; }
export interface CodexTurnResponse { id:string; status:"completed"|"failed"|"incomplete"; output:CodexOutputItem[]; outputText:string; reasoningSummaries:string[]; usage?:CodexUsage; }
export interface CodexFunctionOutput {type:"function_call_output";call_id:string;output:string}
/** ChatGPT Codex requires non-persistence and encrypted reasoning replay. */
export interface CodexRequest {
  model: string;
  instructions: string;
  input: unknown[];
  tools: unknown[];
  tool_choice: "auto";
  parallel_tool_calls: boolean;
  store: false;
  stream: true;
  include: ["reasoning.encrypted_content"];
}

export function asRecord(value:unknown, message="Malformed Codex response"):Record<string,unknown>{if(!value||typeof value!=="object"||Array.isArray(value))throw new Error(message);return value as Record<string,unknown>}
export function stringField(record:Record<string,unknown>,name:string):string|undefined{return typeof record[name]==="string"?record[name] as string:undefined;}
