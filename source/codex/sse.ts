export interface SSEEvent { event?:string; data:string; id?:string; }

/** Incremental SSE decoder supporting CRLF, arbitrary chunks and multiline data. */
export class SSEDecoder {
  private buffer=""; private data:string[]=[]; private event?:string; private id?:string; private readonly textDecoder=new TextDecoder();
  push(chunk:Uint8Array|string):SSEEvent[]{this.buffer+=typeof chunk==="string"?chunk:this.textDecoder.decode(chunk,{stream:true});return this.drain(false);}
  finish():SSEEvent[]{this.buffer+=this.textDecoder.decode();return this.drain(true);}
  private drain(final:boolean):SSEEvent[]{const out:SSEEvent[]=[];let start=0;for(let i=0;i<this.buffer.length;i++){if(this.buffer[i]!=="\n"&&this.buffer[i]!=="\r")continue;if(this.buffer[i]==="\r"&&i===this.buffer.length-1&&!final)break;const line=this.buffer.slice(start,i);if(this.buffer[i]==="\r"&&this.buffer[i+1]==="\n")i++;start=i+1;this.line(line,out);}this.buffer=this.buffer.slice(start);if(final){if(this.buffer)this.line(this.buffer,out);this.buffer="";this.dispatch(out);}return out;}
  private line(line:string,out:SSEEvent[]):void{if(line===""){this.dispatch(out);return;}if(line.startsWith(":"))return;const colon=line.indexOf(":");const field=colon<0?line:line.slice(0,colon);let value=colon<0?"":line.slice(colon+1);if(value.startsWith(" "))value=value.slice(1);if(field==="data")this.data.push(value);else if(field==="event")this.event=value;else if(field==="id"&&!value.includes("\0"))this.id=value;}
  private dispatch(out:SSEEvent[]):void{if(this.data.length)out.push({event:this.event,data:this.data.join("\n"),id:this.id});this.data=[];this.event=undefined;}
}

export async function* decodeSSE(stream:ReadableStream<Uint8Array>):AsyncGenerator<SSEEvent>{const decoder=new SSEDecoder();const reader=stream.getReader();try{while(true){const {done,value}=await reader.read();if(done)break;if(value)yield*decoder.push(value);}yield*decoder.finish();}finally{reader.releaseLock();}}
