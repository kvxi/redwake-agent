import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
const PATH=join(homedir(),"redwake","agent","installation-id");
export function installationId(path=PATH):string{try{const value=readFileSync(path,"utf8").trim();if(/^[0-9a-f-]{36}$/i.test(value))return value;}catch{}const value=crypto.randomUUID();mkdirSync(dirname(path),{recursive:true,mode:0o700});try{writeFileSync(path,`${value}\n`,{mode:0o600,flag:"wx"});}catch{try{const existing=readFileSync(path,"utf8").trim();if(/^[0-9a-f-]{36}$/i.test(existing))return existing;}catch{}}try{chmodSync(path,0o600);}catch{}return value;}
