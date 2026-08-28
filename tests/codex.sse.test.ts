import { describe, expect, test } from "bun:test";
import { SSEDecoder } from "../source/codex/sse.ts";
import { normalizeModels } from "../source/codex/models.ts";
import { CODEX_COMPATIBILITY, CODEX_MODELS_URL, codexHeaders } from "../source/codex/constants.ts";
import { CodexAgent } from "../source/agent/codex.ts";
import { CodexTransport } from "../source/codex/transport.ts";
import type { CredentialManager } from "../source/auth/credential-manager.ts";
import type { CodexRequest, CodexTurnResponse } from "../source/codex/wire.ts";

describe("Codex SSE",()=>{
 test("handles byte boundaries, unicode, CRLF, comments, and multiline data",()=>{const bytes=new TextEncoder().encode(": ping\r\nevent: note\r\ndata: hé\r\ndata: two\r\n\r\n");const decoder=new SSEDecoder();const events=[];for(const byte of bytes)events.push(...decoder.push(new Uint8Array([byte])));events.push(...decoder.finish());expect(events).toEqual([{event:"note",data:"hé\ntwo",id:undefined}]);});
 test("dispatches an unterminated final event",()=>{const decoder=new SSEDecoder();expect([...decoder.push("data: final"),...decoder.finish()]).toEqual([{event:undefined,data:"final",id:undefined}]);});
});

describe("Codex model normalization",()=>{test("accepts envelopes, drops hidden models, and sorts priority",()=>{expect(normalizeModels({data:[{id:"low",priority:1},{slug:"high",display_name:"High",priority:2},{id:"hidden",hidden:true}]}).map((m)=>m.id)).toEqual(["high","low"]);});});

describe("Codex model discovery request",()=>{test("sends the Codex client version using the backend contract",()=>{const url=new URL(CODEX_MODELS_URL);const headers=codexHeaders("token","account");expect(url.searchParams.get("client_version")).toBe(CODEX_COMPATIBILITY.clientVersion);expect(headers.version).toBe(CODEX_COMPATIBILITY.clientVersion);expect(headers.originator).toBe("redwake");expect(headers["x-openai-originator"]).toBeUndefined();});});

describe("Codex Responses contract",()=>{
 test("adds the fields required by the ChatGPT Codex endpoint",async()=>{let request:CodexRequest|undefined;const transport={createResponse:async(body:CodexRequest)=>{request=body;return{id:"response",status:"completed",output:[],outputText:"",reasoningSummaries:[]} satisfies CodexTurnResponse;}} as unknown as CodexTransport;const agent=new CodexAgent({transport,model:"gpt-codex-test"});await agent.createResponse("Test instructions");expect(request).toEqual(expect.objectContaining({model:"gpt-codex-test",instructions:"Test instructions",tool_choice:"auto",parallel_tool_calls:true,store:false,stream:true,include:["reasoning.encrypted_content"]}));expect(request).not.toHaveProperty("max_output_tokens");});
 test("surfaces the backend validation detail for non-success responses",async()=>{const credentials={lease:async()=>({accountId:"account",accessToken:"token"})} as unknown as CredentialManager;const transport=new CodexTransport({credentials,installationId:"installation",sessionId:"session",fetch:(async()=>new Response(JSON.stringify({detail:"Missing required parameter: store"}),{status:400,headers:{"content-type":"application/json","x-request-id":"req_test"}})) as unknown as typeof fetch});const request:CodexRequest={model:"model",instructions:"instructions",input:[],tools:[],tool_choice:"auto",parallel_tool_calls:true,store:false,stream:true,include:["reasoning.encrypted_content"]};expect(transport.createResponse(request)).rejects.toThrow("Missing required parameter: store; request ID: req_test");});
});
