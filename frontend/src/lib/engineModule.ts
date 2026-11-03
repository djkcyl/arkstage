import { parse } from "acorn";
import { installMusicContinuity } from "./musicContinuity.js";

// Discover capabilities by syntax and public object keys. Upstream chunk hashes,
// minified identifiers and import aliases are deliberately not part of this API.
type Syntax = { type: string; start: number; end: number; [key: string]: unknown };
const node = (value: unknown): Syntax | undefined => value && typeof value === "object" && "type" in value
  ? value as Syntax : undefined;
const child = (value: Syntax | undefined, key: string) => node(value?.[key]);
const children = (value: Syntax, key: string): Syntax[] => Array.isArray(value[key])
  ? (value[key] as unknown[]).map(node).filter((n): n is Syntax => !!n) : [];
const name = (value: Syntax | undefined): string => String(value?.name ?? value?.value ?? "");

function walk(value: unknown, visit: (n: Syntax) => void): void {
  const current = node(value);
  if (!current) return;
  visit(current);
  for (const value of Object.values(current)) {
    if (Array.isArray(value)) value.forEach((item) => walk(item, visit));
    else if (node(value)) walk(value, visit);
  }
}

function descendants(value: Syntax, predicate: (n: Syntax) => boolean): Syntax[] {
  const found: Syntax[] = [];
  walk(value, (n) => { if (predicate(n)) found.push(n); });
  return found;
}

function program(source: string): Syntax {
  return parse(source, { ecmaVersion: "latest", sourceType: "module" }) as unknown as Syntax;
}

function returnedObject(fn: Syntax, keys: string[]): boolean {
  return descendants(fn, (n) => n.type === "ReturnStatement").some((ret) => {
    const argument = child(ret, "argument");
    if (!argument) return false;
    return descendants(argument, (n) => n.type === "ObjectExpression").some((object) => {
      const props = children(object, "properties").map((p) => name(child(p, "key")));
      return keys.every((key) => props.includes(key));
    });
  });
}

export function moduleDependencies(source: string, url: string): string[] {
  const urls = new Set<string>();
  walk(program(source), (n) => {
    if (!["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"].includes(n.type)) return;
    const specifier = child(n, "source")?.value;
    if (typeof specifier === "string") urls.add(new URL(specifier, url).href);
  });
  return [...urls];
}

/** Adapt a discovered upstream entry to an explicit, small engine interface. */
export function buildEngineModule(source: string, entryUrl: string, modules: ReadonlyMap<string, string>, toLocal: (url: string) => string): string {
  const ast = program(source);
  const top = children(ast, "body");
  const functions = top.filter((n) => n.type === "FunctionDeclaration");
  const fail = (capability: string): never => { throw new Error(`PRTS 模块接口不兼容：缺少 ${capability}`); };
  const required = (fn: Syntax | undefined, capability: string) => fn ? name(child(fn, "id")) : fail(capability);
  const factory = required(functions.find((fn) => returnedObject(fn, ["mount", "start", "advance", "destroy", "getState"])), "createStoryPlayer");
  const collect = required(functions.find((fn) => returnedObject(fn, ["faceAssets", "urls"])), "资源清单");

  let contextLoader = "";
  for (const declaration of top.filter((n) => n.type === "ImportDeclaration")) {
    const url = new URL(String(child(declaration, "source")?.value), entryUrl).href;
    const dependency = modules.get(url);
    if (!dependency) continue;
    const imported = program(dependency);
    const loader = children(imported, "body").find((fn) => fn.type === "FunctionDeclaration"
      && returnedObject(fn, ["script", "scriptText", "linkMap", "storyMetadata"]));
    if (!loader) continue;
    const local = name(child(loader, "id"));
    for (const exported of children(imported, "body").filter((n) => n.type === "ExportNamedDeclaration")) {
      const spec = children(exported, "specifiers").find((s) => name(child(s, "local")) === local);
      if (!spec) continue;
      const importedName = name(child(spec, "exported"));
      const binding = children(declaration, "specifiers").find((s) => name(child(s, "imported")) === importedName);
      if (binding) contextLoader = name(child(binding, "local"));
    }
  }
  if (!contextLoader) fail("loadContextByScript");

  const calls = (fn: Syntax) => descendants(fn, (n) => n.type === "CallExpression");
  const preloader = functions.find((fn) => fn.async && calls(fn).some((call) => {
    const callee = child(call, "callee");
    return callee?.type === "MemberExpression" && name(child(callee, "property")) === "load"
      && descendants(fn, (n) => n.type === "VariableDeclarator").some((decl) => {
        const init = child(decl, "init");
        const helper = functions.find((f) => name(child(f, "id")) === name(child(init, "callee")));
        return init?.type === "CallExpression" && helper && calls(helper).some((c) => name(child(c, "callee")) === collect);
      });
  }));
  const preload = required(preloader, "preloadContextAssets");
  if (!preloader) fail("预加载");
  const assetLoad = calls(preloader!).find((call) => name(child(child(call, "callee"), "property")) === "load");
  const assets = name(child(child(assetLoad, "callee"), "object"));
  const declarations = descendants(preloader!, (n) => n.type === "VariableDeclarator");
  const helperDecl = declarations.find((decl) => {
    const init = child(decl, "init");
    const helper = functions.find((f) => name(child(f, "id")) === name(child(init, "callee")));
    return init?.type === "CallExpression" && helper && calls(helper).some((c) => name(child(c, "callee")) === collect);
  });
  const assetCall = child(helperDecl, "init");
  const assetCollector = name(child(assetCall, "callee"));
  const parsed = name(children(assetCall!, "arguments")[1]);
  const parseDecl = declarations.find((d) => name(child(d, "id")) === parsed);
  const parseContext = name(child(child(parseDecl, "init"), "callee"));
  const fontDecl = declarations.find((decl) => {
    const init = child(decl, "init");
    return init?.type === "CallExpression" && children(init, "arguments").length === 1
      && name(children(init, "arguments")[0]) === parsed;
  });
  const fontCollector = name(child(child(fontDecl, "init"), "callee"));
  const fontConstructor = functions.flatMap((fn) => descendants(fn, (n) => n.type === "NewExpression"
    && name(child(n, "callee")) === "FontFace"))[0];
  const fontUrl = fontConstructor && descendants(children(fontConstructor, "arguments")[1], (n) => n.type === "CallExpression")[0];
  const fontResolver = name(child(fontUrl, "callee"));
  if (![assetCollector, parseContext, fontCollector, fontResolver].every(Boolean)) fail("字体与内置资源清单");

  const edits: Array<{ start: number; end: number; text: string }> = [];
  // The wiki prefers WebGPU and unbounded display resolution. Android emulators
  // can expose an adapter whose native driver dies during device/context setup.
  // Keep the upstream renderer but use WebGL and a bounded drawing buffer.
  for (const call of descendants(ast, (n) => n.type === "CallExpression"
    && name(child(child(n, "callee"), "property")) === "init")) {
    const options = children(call, "arguments")[0];
    if (options?.type !== "ObjectExpression") continue;
    const properties = children(options, "properties");
    const preference = properties.find((p) => name(child(p, "key")) === "preference");
    const resolution = properties.find((p) => name(child(p, "key")) === "resolution");
    if (!preference || !resolution) continue;
    const value = child(preference, "value")!;
    edits.push({ ...value, text: '"webgl"' });
    const antialias = properties.find((p) => name(child(p, "key")) === "antialias");
    if (antialias) edits.push({ ...child(antialias, "value")!, text: "false" });
    const resolver = name(child(child(resolution, "value"), "callee"));
    const resolutionFunction = functions.find((fn) => name(child(fn, "id")) === resolver);
    if (resolutionFunction) for (const ret of descendants(resolutionFunction, (n) => n.type === "ReturnStatement")) {
      const argument = child(ret, "argument");
      if (argument) edits.push({ ...argument, text: `Math.min(1.5, Math.max(0.5, ${source.slice(argument.start, argument.end)}))` });
    }
  }
  const factoryNode = functions.find((fn) => name(child(fn, "id")) === factory)!;
  const playerObject = descendants(factoryNode, (n) => n.type === "ObjectExpression").find((n) => {
    const keys = children(n, "properties").map((p) => name(child(p, "key")));
    return ["mount", "advance", "getState"].every((key) => keys.includes(key));
  });
  const mount = playerObject && children(playerObject, "properties").find((p) => name(child(p, "key")) === "mount");
  const rendererCall = mount && descendants(mount, (n) => n.type === "CallExpression"
    && name(child(child(n, "callee"), "property")) === "mount")[0];
  const renderer = name(child(child(rendererCall, "callee"), "object"));
  if (playerObject && renderer) edits.push({ start: playerObject.end - 1, end: playerObject.end - 1,
    text: `${source.slice(playerObject.start, playerObject.end - 1).trimEnd().endsWith(",") ? "" : ","} getRenderer: () => ${renderer}` });
  const soundAssignment = descendants(ast, (n) => n.type === "AssignmentExpression"
    && name(child(child(n, "left"), "property")) === "disableAutoPause")[0];
  const sound = name(child(child(soundAssignment, "left"), "object"));
  const isMusicClass = (n: Syntax) => ["ClassDeclaration", "ClassExpression"].includes(n.type)
    && ["playMusic", "stopMusic", "createPlayback", "getSound", "destroy"].every(key =>
      children(child(n, "body")!, "body").some(method => name(child(method, "key")) === key));
  const audioClass = top.find(isMusicClass);
  const audioBinding = top.filter(n => n.type === "VariableDeclaration")
    .flatMap(n => children(n, "declarations")).find(n => {
      const init = child(n, "init");
      return !!init && isMusicClass(init);
    });
  const audioName = name(child(audioClass ?? audioBinding, "id"));
  walk(ast, (n) => {
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"].includes(n.type)) {
      const spec = child(n, "source");
      if (spec && typeof spec.value === "string") edits.push({ ...spec, text: JSON.stringify(toLocal(new URL(spec.value, entryUrl).href)) });
    }
    if (n.type === "MemberExpression" && child(n, "object")?.type === "MetaProperty"
      && name(child(n, "property")) === "url") edits.push({ ...n, text: JSON.stringify(toLocal(entryUrl)) });
  });
  // The wiki entry normally mounts its own Vue lobby. The app owns the toolbar
  // and stage, so omit that top-level side effect and use the engine's own APIs.
  const bootstrap = top.filter((n) => n.type === "ExpressionStatement"
    && descendants(n, (c) => c.type === "CallExpression"
      && name(child(child(c, "callee"), "property")) === "mount").length > 0);
  for (const n of bootstrap) edits.push({ ...n, text: "" });
  const activeEdits = edits.filter((edit) => !bootstrap.some((b) => edit.start > b.start && edit.end < b.end));
  let output = source;
  for (const edit of activeEdits.sort((a, b) => b.start - a.start)) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  return `${output}\n${assets}.setPreferences?.({preferWorkers: false});\n${audioName ? `(${installMusicContinuity.toString()})(${audioName}.prototype, url => ${assets}.unload(url));` : ""}\nexport const arkstageEngine = {
    musicContinuity: ${!!audioName},
    createPlayer: ${factory}, loadContext: ${contextLoader},
    async preload(context, onProgress) {
      const originalLoad = ${assets}.load;
      // Audio is loaded by the native audio engine on demand. Decoding every
      // music track into PCM before mount can kill a mobile renderer process.
      ${assets}.load = async function(input, options) {
        if (!Array.isArray(input)) return originalLoad.call(this, input, options);
        const urls = input.filter(item => !/\\.(mp3|ogg|wav|m4a|aac|flac)(?:[?#]|$)/i.test(typeof item === 'string' ? item : item.src || ''));
        const progress = typeof options === 'function' ? options : options?.onProgress;
        const results = {};
        for (let start = 0; start < urls.length; start += 2) {
          const batch = urls.slice(start, start + 2);
          const report = value => progress?.((start + value * batch.length) / urls.length);
          const next = typeof options === 'function' ? report : {...options, onProgress: report};
          Object.assign(results, await originalLoad.call(this, batch, next));
        }
        if (!urls.length) progress?.(1);
        return results;
      };
      try { await ${preload}(context, onProgress); }
      finally { ${assets}.load = originalLoad; }
    },
    setVolume(volume) { ${sound ? `${sound}.volumeAll = volume;` : "void volume;"} },
    manifest(context) { const lines = ${parseContext}(context); return [...new Set([
      ...${assetCollector}(context, lines), ...${fontCollector}(lines).map(font => ${fontResolver}(font.file))
    ])]; }
  };\n`;
}
