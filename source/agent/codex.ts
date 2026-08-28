import type { ResponseInput } from "openai/resources/responses/responses";
import { modelFor } from "../config.ts";
import { toOpenAITools } from "../tools/registry.ts";
import { CodexTransport } from "../codex/transport.ts";
import type { CodexFunctionOutput, CodexRequest, CodexTurnResponse } from "../codex/wire.ts";
import { AgentBase, type AgentBaseOptions, type NormalizedToolCall } from "./base.ts";
import { toOpenAIHistory } from "./history.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
export interface CodexAgentOptions extends AgentBaseOptions {transport:CodexTransport;model?:string;}
export class CodexAgent extends AgentBase<CodexTurnResponse,CodexFunctionOutput>{private readonly model:string;private readonly input:ResponseInput;private readonly tools=toOpenAITools();constructor(private readonly options:CodexAgentOptions){super(options);this.model=options.model??modelFor("openai-codex");this.input=toOpenAIHistory(this.conversation.snapshot(1_200_000));}
 createResponse(system?:string):Promise<CodexTurnResponse>{const instructions=system?.trim()?system:buildSystemPrompt();const body:CodexRequest={model:this.model,instructions,input:this.input as unknown[],tools:this.tools as unknown[],tool_choice:"auto",parallel_tool_calls:true,store:false,stream:true,include:["reasoning.encrypted_content"]};return this.options.transport.createResponse(body);}
 protected appendUser(message:string):void{this.input.push({role:"user",content:message});}
 protected request():Promise<CodexTurnResponse>{return this.createResponse();}
 protected remember(response:CodexTurnResponse):void{this.input.push(...response.output as ResponseInput);}
 protected responseText(response:CodexTurnResponse):string{return response.outputText;}
 protected *toolCalls(response:CodexTurnResponse):Iterable<NormalizedToolCall>{for(const item of response.output){if(item.type!=="function_call"||typeof item.call_id!=="string"||typeof item.name!=="string"||typeof item.arguments!=="string")continue;try{yield{id:item.call_id,name:item.name,input:JSON.parse(item.arguments)};}catch(error){yield{id:item.call_id,name:item.name,input:item.arguments,inputError:error instanceof Error?error.message:String(error)};}}}
 protected encodeToolResult(call:NormalizedToolCall,content:string):CodexFunctionOutput{return{type:"function_call_output",call_id:call.id,output:content};}
 protected appendToolResults(results:CodexFunctionOutput[]):void{this.input.push(...results);}
}
