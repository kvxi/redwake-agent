import { closeSync, lstatSync, openSync, opendirSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  Node,
  Project,
  SyntaxKind,
  type ClassDeclaration,
  type InterfaceDeclaration,
  type SourceFile,
} from "ts-morph";

export interface RepoMapOptions {
  workspaceRoot: string;
  maxTokens?: number;
  homeDirectory?: string;
  limits?: Partial<RepoMapLimits>;
  /** Narrow seams for deterministic budget/transport tests. */
  now?: () => number;
  gitFiles?: (root: string) => { status: number | null; stdout: string; error?: unknown };
}

export interface RepoMapResult {
  text: string;
  estimatedTokens: number;
  includedFiles: number;
  omittedFiles: number;
  includedSymbols: number;
  omittedSymbols: number;
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_DIRECTORIES = new Set([".git", "node_modules", "dist", "coverage", ".nyc_output", "build", "out"]);
const SKIP_NAMES = /(?:^|\/)(?:bun\.lock|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$|(?:\.d)?\.ts\.map$|\.min\.(?:js|css)$/i;

/** A conservative, provider-neutral estimate used solely to enforce map size. */
export function estimateRepoMapTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

function posix(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function acceptable(path: string): boolean {
  const parts = posix(path).split("/");
  return !parts.some((part) => SKIP_DIRECTORIES.has(part)) && !SKIP_NAMES.test(path) &&
    !parts.some((part) => part === ".env" || part.startsWith(".env."));
}

export interface RepoMapLimits {
  files: number;
  entries: number;
  depth: number;
  discoveryMs: number;
  sourceFiles: number;
  sourceBytes: number;
  totalSourceBytes: number;
}

const DEFAULT_LIMITS: RepoMapLimits = {
  files: 2_000, entries: 10_000, depth: 8, discoveryMs: 1_000,
  sourceFiles: 200, sourceBytes: 256 * 1024, totalSourceBytes: 4 * 1024 * 1024,
};

function canonical(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

export function isBroadWorkspace(root: string, homeDirectory = homedir()): boolean {
  const path = canonical(root);
  return path === canonical(homeDirectory) || path === parse(path).root;
}

/** Reads at most limit bytes, including for files that grow while being read. */
export function readRepoMapPrefix(path: string, limit: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(limit);
    let length = 0;
    while (length < limit) {
      const count = readSync(fd, buffer, { offset: length, length: limit - length });
      if (!count) break;
      length += count;
    }
    return buffer.subarray(0, length);
  } finally { closeSync(fd); }
}

function discoverFiles(root: string, limits: RepoMapLimits, options: RepoMapOptions): { files: string[]; limited: boolean } {
  const now = options.now ?? Date.now;
  const deadline = now() + limits.discoveryMs;
  let limited = false;
  let visited = 0;
  const files: string[] = [];
  const exhausted = (): boolean => {
    const stop = files.length >= limits.files || visited >= limits.entries || now() >= deadline;
    if (stop) limited = true;
    return stop;
  };
  const admit = (path: string): void => {
    if (!path || isAbsolute(path) || path.split("/").includes("..") || !acceptable(path)) return;
    try {
      // Git may report symlinks (including parent directories), unlike the walker.
      let absolute = root;
      for (const part of path.split("/")) {
        absolute = join(absolute, part);
        if (lstatSync(absolute).isSymbolicLink()) return;
      }
      if (!lstatSync(absolute).isFile()) return;
      if (!readRepoMapPrefix(absolute, 8_192).includes(0)) files.push(path);
    } catch { /* unreadable/disappearing files are optional */ }
  };
  const git = (options.gitFiles ?? ((directory: string) => spawnSync("git", ["-C", directory, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 1_000,
  })))(root);
  const gitMissing = (git.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
  if ((git.error || git.status === null) && !gitMissing) return { files, limited: true };
  if (git.status === 0) {
    for (const path of git.stdout.split("\0")) {
      if (exhausted()) break;
      visited += 1;
      admit(posix(path));
    }
  } else {
    const walk = (directory: string, depth: number): void => {
      if (exhausted()) return;
      let handle;
      try { handle = opendirSync(directory); } catch { return; }
      try {
        while (!exhausted()) {
          const entry = handle.readSync();
          if (!entry) break;
          visited += 1;
          if (entry.isSymbolicLink()) continue;
          const absolute = join(directory, entry.name);
          const rel = posix(relative(root, absolute));
          if (!acceptable(rel)) continue;
          if (entry.isDirectory()) {
            if (depth >= limits.depth) { limited = true; continue; }
            walk(absolute, depth + 1);
          } else if (entry.isFile()) admit(rel);
        }
      } catch { /* permission errors remain nonfatal */ }
      finally { handle.closeSync(); }
    };
    walk(root, 0);
  }
  return { files: [...new Set(files)].sort((a, b) => a.localeCompare(b)), limited };
}

function compactType(text: string | undefined, fallback = "unknown"): string {
  if (!text) return fallback;
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= 180 ? compact : fallback;
}

function declaredOrInferredType(
  explicit: Node | undefined,
  inferred: () => { getText(node?: Node): string },
  context: Node,
): string {
  if (explicit) return compactType(explicit.getText());
  try { return compactType(inferred().getText(context)); } catch { return "unknown"; }
}

function typeParameters(node: { getTypeParameters(): Array<{ getText(): string }> }): string {
  const values = node.getTypeParameters().map((parameter) => compactType(parameter.getText()));
  return values.length ? `<${values.join(", ")}>` : "";
}

function parameters(node: { getParameters(): Array<{ getText(): string; getName(): string }> }): string {
  return node.getParameters().map((parameter) => {
    let text = parameter.getText().replace(/\s*=.*$/s, "").replace(/\s+/g, " ").trim();
    if (text.length > 160) text = `${parameter.getName()}: unknown`;
    return text;
  }).join(", ");
}

function heritage(node: InterfaceDeclaration | ClassDeclaration): string {
  const parts: string[] = [];
  const extended = Node.isClassDeclaration(node)
    ? (node.getExtends() ? [compactType(node.getExtends()!.getText())] : [])
    : node.getExtends().map((item) => compactType(item.getText()));
  if (extended.length) parts.push(`extends ${extended.join(", ")}`);
  if (Node.isClassDeclaration(node)) {
    const implemented = node.getImplements().map((item) => compactType(item.getText()));
    if (implemented.length) parts.push(`implements ${implemented.join(", ")}`);
  }
  return parts.length ? ` ${parts.join(" ")}` : "";
}

function visibility(node: Node & { hasModifier(kind: SyntaxKind): boolean }): string {
  if (node.hasModifier(SyntaxKind.ProtectedKeyword)) return "protected ";
  if (node.hasModifier(SyntaxKind.StaticKeyword)) return "static ";
  return "";
}

function members(node: InterfaceDeclaration | ClassDeclaration): string[] {
  const output: string[] = [];
  for (const member of node.getMembers()) {
    if (Node.isClassDeclaration(node) && "hasModifier" in member && member.hasModifier(SyntaxKind.PrivateKeyword)) continue;
    const prefix = "hasModifier" in member ? visibility(member as Node & { hasModifier(kind: SyntaxKind): boolean }) : "";
    if (Node.isConstructorDeclaration(member)) {
      output.push(`constructor(${parameters(member)})`);
    } else if (Node.isMethodDeclaration(member) || Node.isMethodSignature(member)) {
      const optional = member.hasQuestionToken() ? "?" : "";
      output.push(`${prefix}${member.getName()}${optional}${typeParameters(member)}(${parameters(member)}): ${declaredOrInferredType(member.getReturnTypeNode(), () => member.getReturnType(), member)}`);
    } else if (Node.isPropertyDeclaration(member) || Node.isPropertySignature(member)) {
      const readonly = member.isReadonly() ? "readonly " : "";
      const optional = member.hasQuestionToken() ? "?" : "";
      output.push(`${prefix}${readonly}${member.getName()}${optional}: ${declaredOrInferredType(member.getTypeNode(), () => member.getType(), member)}`);
    } else if (Node.isGetAccessorDeclaration(member)) {
      output.push(`${prefix}get ${member.getName()}(): ${declaredOrInferredType(member.getReturnTypeNode(), () => member.getReturnType(), member)}`);
    } else if (Node.isSetAccessorDeclaration(member)) {
      output.push(`${prefix}set ${member.getName()}(${parameters(member)})`);
    } else if (Node.isCallSignatureDeclaration(member)) {
      output.push(`${typeParameters(member)}(${parameters(member)}): ${declaredOrInferredType(member.getReturnTypeNode(), () => member.getReturnType(), member)}`);
    }
  }
  return output;
}

interface SymbolSkeleton { line: number; text: string; exported: boolean; position: number }

function skeletons(file: SourceFile): SymbolSkeleton[] {
  const output: SymbolSkeleton[] = [];
  for (const statement of file.getStatements()) {
    let head: string | undefined;
    let children: string[] = [];
    let exported = "isExported" in statement && (statement as { isExported(): boolean }).isExported();
    const exp = exported ? "export " : "";
    if (Node.isFunctionDeclaration(statement) && statement.getName()) {
      const async = statement.isAsync() ? "async " : "";
      head = `${exp}${async}function ${statement.getName()}${typeParameters(statement)}(${parameters(statement)}): ${declaredOrInferredType(statement.getReturnTypeNode(), () => statement.getReturnType(), statement)}`;
    } else if (Node.isClassDeclaration(statement) && statement.getName()) {
      const abstract = statement.isAbstract() ? "abstract " : "";
      head = `${exp}${abstract}class ${statement.getName()}${typeParameters(statement)}${heritage(statement)}`;
      children = members(statement);
    } else if (Node.isInterfaceDeclaration(statement)) {
      head = `${exp}interface ${statement.getName()}${typeParameters(statement)}${heritage(statement)}`;
      children = members(statement);
    } else if (Node.isTypeAliasDeclaration(statement)) {
      head = `${exp}type ${statement.getName()}${typeParameters(statement)} = ${compactType(statement.getTypeNode()?.getText())}`;
    } else if (Node.isEnumDeclaration(statement)) {
      head = `${exp}enum ${statement.getName()} { ${statement.getMembers().map((item) => item.getName()).join(", ")} }`;
    } else if (Node.isVariableStatement(statement)) {
      const kind = statement.getDeclarationKind();
      const declarations = statement.getDeclarations();
      for (const declaration of declarations) {
        const initializer = declaration.getInitializer();
        const callable = initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer));
        const value = callable
          ? `${declaration.getName()}(${parameters(initializer)}): ${declaredOrInferredType(initializer.getReturnTypeNode(), () => initializer.getReturnType(), initializer)}`
          : `${declaration.getName()}: ${declaredOrInferredType(declaration.getTypeNode(), () => declaration.getType(), declaration)}`;
        output.push({ line: declaration.getStartLineNumber(), text: `${exp}${kind} ${value}`, exported, position: declaration.getStart() });
      }
      continue;
    } else if (Node.isExportDeclaration(statement)) {
      const clause = statement.getNamedExports().map((item) => item.getText()).join(", ");
      const target = statement.getModuleSpecifierValue();
      head = clause ? `export { ${clause} }${target ? ` from ${JSON.stringify(target)}` : ""}` : target ? `export * from ${JSON.stringify(target)}` : undefined;
      exported = true;
    }
    if (!head) continue;
    const text = [head, ...children.slice(0, 12).map((child) => `  ${child}`)].join("\n");
    output.push({ line: statement.getStartLineNumber(), text, exported, position: statement.getStart() });
  }
  return output;
}

function entryPointScore(path: string, packageEntries: Set<string>): number {
  let score = packageEntries.has(path.replace(/^\.\//, "")) ? 10 : 0;
  const base = path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
  if (["cli", "main", "index"].includes(base)) score += 5;
  if (/^(?:source|src|lib)\//.test(path)) score += 2;
  if (/(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.test\./.test(path)) score -= 2;
  return score;
}

interface TreeLine { text: string; files: number }

function compactTree(paths: readonly string[]): TreeLine[] {
  interface Directory { files: string[]; directories: Map<string, Directory> }
  const root: Directory = { files: [], directories: new Map() };
  for (const path of paths) {
    const parts = path.split("/");
    const file = parts.pop();
    if (!file) continue;
    let directory = root;
    for (const part of parts) {
      let child = directory.directories.get(part);
      if (!child) {
        child = { files: [], directories: new Map() };
        directory.directories.set(part, child);
      }
      directory = child;
    }
    directory.files.push(file);
  }
  const output: TreeLine[] = [];
  const visit = (directory: Directory, depth: number): void => {
    const indent = "  ".repeat(depth);
    const names = directory.files.sort((a, b) => a.localeCompare(b));
    if (depth === 0 || names.join(",").length > 90 || names.length < 2) {
      for (const name of names) output.push({ text: `${indent}${name}`, files: 1 });
    } else if (names.length) {
      output.push({ text: `${indent}{${names.join(",")}}`, files: names.length });
    }
    for (const [name, child] of [...directory.directories].sort(([a], [b]) => a.localeCompare(b))) {
      output.push({ text: `${indent}${name}/`, files: 0 });
      visit(child, depth + 1);
    }
  };
  visit(root, 0);
  return output;
}

function packageEntries(root: string): Set<string> {
  const result = new Set<string>();
  try {
    const path = join(root, "package.json");
    if (!lstatSync(path).isFile()) return result;
    const text = readRepoMapPrefix(path, 64 * 1024 + 1);
    if (text.length > 64 * 1024) return result;
    const pkg = JSON.parse(text.toString("utf8")) as Record<string, unknown>;
    const collect = (value: unknown): void => {
      if (typeof value === "string") result.add(posix(value).replace(/^\.\//, ""));
      else if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === "object") Object.values(value).forEach(collect);
    };
    [pkg.bin, pkg.main, pkg.module, pkg.exports].forEach(collect);
  } catch { /* package metadata is optional */ }
  return result;
}

function omissionLine(files: number, symbols: number): string {
  return `... ${files} lower-ranked files and ${symbols} symbols omitted to fit map budget`;
}

export function generateRepoMap(options: RepoMapOptions): RepoMapResult {
  const root = resolve(options.workspaceRoot);
  if (isBroadWorkspace(root, options.homeDirectory)) {
    return { text: "", estimatedTokens: 0, includedFiles: 0, omittedFiles: 0, includedSymbols: 0, omittedSymbols: 0 };
  }
  const limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(limits) as Array<keyof RepoMapLimits>) {
    const value = options.limits?.[key];
    if (value !== undefined && Number.isFinite(value)) limits[key] = Math.max(0, Math.floor(value));
  }
  const requested = options.maxTokens ?? Number(process.env.REPO_MAP_MAX_TOKENS || 1_000);
  const maxTokens = Number.isFinite(requested) ? Math.max(32, Math.floor(requested)) : 1_000;
  try {
    const discovery = discoverFiles(root, limits, options);
    const files = discovery.files;
    let limited = discovery.limited;
    const sourcePaths = files.filter((path) => SOURCE_EXTENSIONS.has(extname(path).toLowerCase()));
    // Explicit in-memory inputs prevent tsconfig/import resolution from escaping budgets.
    const project = new Project({
      useInMemoryFileSystem: true,
      compilerOptions: { allowJs: true, checkJs: false },
      skipFileDependencyResolution: true,
    });
    let sourceCount = 0;
    let sourceBytes = 0;
    for (const path of sourcePaths) {
      if (sourceCount >= limits.sourceFiles || sourceBytes >= limits.totalSourceBytes) { limited = true; break; }
      try {
        const cap = Math.min(limits.sourceBytes, limits.totalSourceBytes - sourceBytes);
        const text = readRepoMapPrefix(join(root, path), cap + 1);
        sourceBytes += text.length;
        sourceCount += 1;
        if (text.length > cap) { limited = true; continue; }
        project.createSourceFile(join(root, path), text.toString("utf8"));
      } catch { /* malformed/unreadable sources remain in the tree */ }
    }

    const sourceFiles = project.getSourceFiles();
    const knownPaths = new Set(sourceFiles.map((file) => posix(relative(root, file.getFilePath()))));
    const inbound = new Map<string, number>();
    const graph = new Map<string, Set<string>>();
    for (const file of sourceFiles) {
      const path = posix(relative(root, file.getFilePath()));
      const edges = new Set<string>();
      for (const declaration of [...file.getImportDeclarations(), ...file.getExportDeclarations()]) {
        const target = declaration.getModuleSpecifierSourceFile();
        if (!target) continue;
        const targetPath = posix(relative(root, target.getFilePath()));
        if (!knownPaths.has(targetPath)) continue;
        edges.add(targetPath);
        inbound.set(targetPath, (inbound.get(targetPath) ?? 0) + 1);
      }
      graph.set(path, edges);
    }
    // A small fixed-iteration PageRank gives central modules priority without
    // introducing convergence or ordering nondeterminism.
    const count = Math.max(1, knownPaths.size);
    let pageRank = new Map([...knownPaths].map((path) => [path, 1 / count]));
    for (let iteration = 0; iteration < 12; iteration += 1) {
      const next = new Map([...knownPaths].map((path) => [path, 0.15 / count]));
      for (const path of [...knownPaths].sort()) {
        const edges = graph.get(path) ?? new Set<string>();
        if (!edges.size) continue;
        const share = 0.85 * (pageRank.get(path) ?? 0) / edges.size;
        for (const target of [...edges].sort()) next.set(target, (next.get(target) ?? 0) + share);
      }
      pageRank = next;
    }
    const entries = packageEntries(root);
    const ranked = project.getSourceFiles().map((file) => {
      const path = posix(relative(root, file.getFilePath()));
      const declarations = skeletons(file);
      const score = entryPointScore(path, entries) + (inbound.get(path) ?? 0) * 2 +
        (pageRank.get(path) ?? 0) * 20 + declarations.filter((item) => item.exported).length * 0.25;
      return { path, declarations, score };
    }).filter((file) => file.declarations.length > 0).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

    const totalSymbols = ranked.reduce((sum, file) => sum + file.declarations.length, 0);
    const totalSourceFiles = sourcePaths.length;
    const treeBudget = Math.floor(maxTokens * 0.2);
    const treeLines: TreeLine[] = [];
    let treeFiles = 0;
    for (const line of compactTree(files)) {
      const candidate = [...treeLines.map((entry) => entry.text), line.text].join("\n");
      if (estimateRepoMapTokens(candidate) > treeBudget) break;
      treeLines.push(line);
      treeFiles += line.files;
    }

    const included = new Map<string, SymbolSkeleton[]>();
    let includedSymbols = 0;
    const render = (noticeFiles: number, noticeSymbols: number): string => {
      const lines = ["<repo_map>", "# files", ...treeLines.map((entry) => entry.text)];
      if (treeFiles < files.length) lines.push(`... ${files.length - treeFiles} files omitted from tree`);
      lines.push("", "# symbols");
      for (const file of ranked) {
        const declarations = included.get(file.path);
        if (!declarations?.length) continue;
        lines.push(file.path);
        for (const declaration of declarations) {
          const parts = declaration.text.split("\n");
          lines.push(`  L${declaration.line} ${parts[0]}`, ...parts.slice(1).map((line) => `    ${line.trimStart()}`));
        }
        lines.push("");
      }
      if (noticeFiles || noticeSymbols) lines.push(omissionLine(noticeFiles, noticeSymbols));
      if (limited) lines.push("... map truncated by scan limits");
      lines.push("</repo_map>");
      return lines.join("\n");
    };

    outer: for (const file of ranked) {
      for (const declaration of file.declarations.sort((a, b) => Number(b.exported) - Number(a.exported) || a.position - b.position)) {
        const current = included.get(file.path) ?? [];
        included.set(file.path, [...current, declaration].sort((a, b) => a.position - b.position));
        includedSymbols += 1;
        const represented = included.size;
        const candidate = render(totalSourceFiles - represented, totalSymbols - includedSymbols);
        if (estimateRepoMapTokens(candidate) > maxTokens) {
          if (current.length) included.set(file.path, current); else included.delete(file.path);
          includedSymbols -= 1;
          continue outer;
        }
      }
    }
    const includedFiles = included.size;
    let text = render(totalSourceFiles - includedFiles, totalSymbols - includedSymbols);
    // Tiny budgets may not accommodate the planned tree. Remove tree entries first.
    while (estimateRepoMapTokens(text) > maxTokens && treeLines.length) {
      treeFiles -= treeLines.pop()!.files;
      text = render(totalSourceFiles - includedFiles, totalSymbols - includedSymbols);
    }
    if (estimateRepoMapTokens(text) > maxTokens) {
      text = limited ? "<repo_map>\n... map truncated by scan limits\n</repo_map>" : `<repo_map>\n... ${totalSymbols - includedSymbols} symbols omitted\n</repo_map>`;
    }
    return {
      text,
      estimatedTokens: estimateRepoMapTokens(text),
      includedFiles,
      omittedFiles: Math.max(0, totalSourceFiles - includedFiles),
      includedSymbols,
      omittedSymbols: Math.max(0, totalSymbols - includedSymbols),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const safe = detail
      .replaceAll(root, ".")
      .replaceAll(posix(root), ".")
      .replace(/[\r\n<>]+/g, " ")
      .slice(0, 160);
    let text = `<repo_map>\nRepository map unavailable: ${safe}\n</repo_map>`;
    if (estimateRepoMapTokens(text) > maxTokens) text = "<repo_map>\nRepository map unavailable.\n</repo_map>";
    return { text, estimatedTokens: estimateRepoMapTokens(text), includedFiles: 0, omittedFiles: 0, includedSymbols: 0, omittedSymbols: 0 };
  }
}
