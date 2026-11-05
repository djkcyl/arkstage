import { parse } from "acorn";
import { installMusicContinuity } from "./musicContinuity.js";
import { logDocumentAt } from "./playerTranscript.js";

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
  // The runtime reports dialogue/subtitle positions but omits sticker text.
  // Notify through the same native setter only after the command reaches an
  // actual show/append call (not a hidden, skipped or invalid sticker).
  for (const method of descendants(ast, n => n.type === "MethodDefinition")) {
    const fn = child(method, "value");
    const parameter = fn && children(fn, "params")[0];
    if (parameter?.type !== "Identifier" || !fn) continue;
    const switchesOnCommand = descendants(fn, n => n.type === "SwitchStatement").some(statement => {
      const value = child(statement, "discriminant");
      return name(child(value, "object")) === name(parameter) && name(child(value, "property")) === "command";
    });
    if (!switchesOnCommand) continue;
    const stickers = calls(fn).filter(call => name(child(child(call, "callee"), "property")) === "setSticker");
    if (!stickers.length) continue;
    const body = child(fn, "body")!;
    // Native executors reuse the parameter's short identifier for the sticker
    // id inside the switch case. Capture the source line outside that scope.
    edits.push({ start: body.start + 1, end: body.start + 1, text: `const __arkstageLogSourceLine=${name(parameter)};` });
    for (const call of stickers) {
      edits.push({ start: call.start, end: call.start, text: "(__arkstageLogSourceLine.args.hidelog===true?void 0:(this.displayedLineIndex=__arkstageLogSourceLine.lineNumber)," });
      edits.push({ start: call.end, end: call.end, text: ")" });
    }
  }
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
  // Reuse the wiki's actual LOG parser and Vue components. Keeping a second
  // regex parser in the HUD loses dialog/aside/multiline semantics and branches.
  const bindings = top.filter(n => n.type === "VariableDeclaration").flatMap(n => children(n, "declarations"));
  const literal = (n: Syntax | undefined) => n?.type === "TemplateLiteral"
    ? String((children(n, "quasis")[0]?.value as { cooked?: string })?.cooked ?? "") : name(n);
  const component = (label: string) => bindings.find(decl => descendants(decl, n => n.type === "Property"
    && name(child(n, "key")) === "__name" && literal(child(n, "value")) === label).length > 0);
  const logPanel = component("LogAllPanel"), logList = component("LogAllList");
  const documentBuilder = functions.find(fn => returnedObject(fn, ["blocks", "conditions", "decisions", "degraded"]));
  const logBuilder = documentBuilder && functions.find(fn => calls(fn).some(call => name(child(call, "callee")) === name(child(documentBuilder, "id"))));
  const appCall = bootstrap.flatMap(n => descendants(n, c => c.type === "CallExpression"
    && name(child(child(c, "callee"), "property")) === "mount"))
    .map(n => child(child(n, "callee"), "object")).find(n => n?.type === "CallExpression");
  const createApp = name(child(appCall, "callee"));
  const createVNode = logPanel && logList && name(child(calls(logPanel).find(call =>
    name(children(call, "arguments")[0]) === name(child(logList, "id"))), "callee"));
  const themeCall = descendants(ast, n => n.type === "VariableDeclarator" && child(n, "id")?.type === "ObjectPattern"
    && ["theme", "themeOverrides"].every(key => children(child(n, "id")!, "properties").some(p => name(child(p, "key")) === key)))
    .map(n => child(n, "init")).find(n => n?.type === "CallExpression");
  const theme = name(child(themeCall, "callee"));
  const configCall = descendants(ast, n => n.type === "CallExpression" && children(n, "arguments").some(arg =>
    arg.type === "ObjectExpression" && ["theme", "themeOverrides"].every(key => children(arg, "properties")
      .some(p => name(child(p, "key")).replaceAll("-", "").toLowerCase() === key.toLowerCase()))))[0];
  const configNode = configCall && children(configCall, "arguments")[0];
  const config = configNode && source.slice(configNode.start, configNode.end);
  const panelOptions = logPanel && descendants(logPanel, n => n.type === "ObjectExpression").find(object =>
    children(object, "properties").some(p => name(child(p, "key")) === "__name"));
  const panelProps = child(panelOptions && children(panelOptions, "properties").find(p => name(child(p, "key")) === "props"), "value");
  const panelSetup = child(panelOptions && children(panelOptions, "properties").find(p => name(child(p, "key")) === "setup"), "value");
  const propsName = panelSetup && name(children(panelSetup, "params")[0]);
  const nativeLog = !!(logPanel && logBuilder && createApp && createVNode && theme && config && panelProps && propsName);
  let nativeLogSeek = false;
  if (logList) for (const object of descendants(logList, n => n.type === "ObjectExpression")) {
    const active = children(object, "properties").find(prop => name(child(prop, "key")) === "data-active-line");
    const row = child(child(active, "value"), "object");
    if (!row) continue;
    const comma = source.slice(object.start, object.end - 1).trimEnd().endsWith(",") ? "" : ",";
    edits.push({ start: object.end - 1, end: object.end - 1,
      text: `${comma}'data-arkstage-log-index':${source.slice(row.start, row.end)}.entry.lineIndex` });
    nativeLogSeek = true;
  }
  // Vue's compiled dynamic-prop list must update the source index as well as
  // the active marker when a live multiline paragraph grows in place.
  if (nativeLogSeek) for (const array of descendants(ast, n => n.type === "ArrayExpression")) {
    if (!children(array, "elements").some(value => literal(value) === "data-active-line")) continue;
    const comma = source.slice(array.start, array.end - 1).trimEnd().endsWith(",") ? "" : ",";
    edits.push({ start: array.end - 1, end: array.end - 1, text: `${comma}'data-arkstage-log-index'` });
  }
  if (nativeLog) {
    const comma = source.slice(panelProps!.start, panelProps!.end - 1).trimEnd().endsWith(",") ? "" : ",";
    edits.push({ start: panelProps!.end - 1, end: panelProps!.end - 1,
      text: `${comma}arkstageReadLog:{type:Boolean},arkstageCanSeek:{type:Boolean},onArkstageLogModeChange:{type:Function}` });
    // Extend the native panel's header while preserving its list, typography,
    // close button, scroll container and responsive layout in both modes.
    for (const value of descendants(panelSetup!, n => ["Literal", "TemplateLiteral"].includes(n.type)
      && literal(n) === "LOG ALL")) {
      edits.push({ ...value, text: `(${propsName}.arkstageReadLog ? 'LOG' : 'LOG ALL')` });
    }
    for (const slot of descendants(panelSetup!, n => n.type === "Property" && name(child(n, "key")) === "header-extra")) {
      edits.push({ ...child(slot, "value")!, text: `() => [
        ${propsName}.arkstageReadLog && ${propsName}.arkstageCanSeek ? ${createVNode}('span', {
          style:'font-size:12px;opacity:.75;margin-right:8px'
        }, '点选对白跳转') : null,
        ${createVNode}('button', {
        type:'button', class:'arkstage-log-switch',
        'aria-label':${propsName}.arkstageReadLog ? '查看全部文本' : '查看已读记录',
        style:'border:1px solid var(--n-border-color,#72777d);border-radius:3px;background:transparent;color:inherit;padding:4px 10px;cursor:pointer;font-size:14px',
        onClick:() => ${propsName}.onArkstageLogModeChange?.()
      }, ${propsName}.arkstageReadLog ? '查看全部文本' : '查看已读记录')]` });
    }
  }
  for (const n of bootstrap) edits.push({ ...n, text: "" });
  const activeEdits = edits.filter((edit) => !bootstrap.some((b) => edit.start > b.start && edit.end < b.end));
  let output = source;
  for (const edit of activeEdits.sort((a, b) => b.start - a.start)) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  return `${output}\n${assets}.setPreferences?.({preferWorkers: false});\n${audioName ? `(${installMusicContinuity.toString()})(${audioName}.prototype, url => ${assets}.unload(url));` : ""}\nexport const arkstageEngine = {
    musicContinuity: ${!!audioName},
    nativeLog: ${nativeLog},
    nativeLogSeek: ${nativeLogSeek},
    createPlayer: ${factory}, loadContext: ${contextLoader},
    ${nativeLog ? `buildLog(context) { return ${name(child(logBuilder, "id"))}(${parseContext}(context), context.audioVariables ?? {}); },
    mountLog(host, document, context, position, fontSize, onClose, onSeek) {
      const lines = ${parseContext}(context);
      const bySourceLine = new Map();
      // The parser's implicit endtip shares the final physical line number.
      // Keep the original display command instead of replacing it with endtip.
      for (const line of lines) if (!bySourceLine.has(line.lineNumber)) bySourceLine.set(line.lineNumber, line);
      let lastKey, lastDocument;
      const decorate = () => Promise.resolve().then(() => {
        const enabled = view.mode === 'read' && !!onSeek;
        for (const row of host.querySelectorAll?.('[data-arkstage-log-index]') ?? []) {
          row.style.cursor = enabled ? 'pointer' : '';
          if (enabled) { row.setAttribute('role','button'); row.setAttribute('tabindex','0'); row.setAttribute('title','跳转到这条已读对白'); }
          else { row.removeAttribute('role'); row.removeAttribute('tabindex'); row.removeAttribute('title'); }
        }
      });
      const documentAt = (position, mode) => {
        const key = JSON.stringify([mode, position]);
        if (key !== lastKey) {
          if (mode === 'read') {
            // Feed only actually displayed lines, in execution order, to the
            // original parser/LOG semantics. No unseen branches or future text.
            const read = (position.readLines ?? []).map((source, index) => {
              const line = bySourceLine.get(source);
              return line && { ...line, lineNumber:index + 1 };
            }).filter(Boolean);
            lastDocument = ${name(child(logBuilder, "id"))}(read, context.audioVariables ?? {});
          } else lastDocument = (${logDocumentAt.toString()})(typeof document === 'function' ? document() : document, position, () =>
            ${name(child(logBuilder, "id"))}(lines.filter(line => line.lineNumber <= position.lineIndex), context.audioVariables ?? {}), true);
          lastKey = key;
        }
        return lastDocument;
      };
      const app = ${createApp}({
        setup() { return ${theme}(); },
        data() { return { position: { lineIndex: null, selections: [], readLines: [] }, mode:'read' }; },
        render() { return ${createVNode}(${config}, {
          theme: this.theme, themeOverrides: { ...this.themeOverrides,
            common: { ...this.themeOverrides?.common, fontSize: fontSize + 'px' } },
          style: { height: '100%' }
        }, { default: () => [${createVNode}(${name(child(logPanel, "id"))}, {
          key:this.mode, show: true, embedded: true, document: documentAt(this.position, this.mode),
          arkstageReadLog:this.mode === 'read',
          arkstageCanSeek:!!onSeek,
          onArkstageLogModeChange:() => { this.mode = this.mode === 'read' ? 'all' : 'read'; },
          activeLineIndex: this.mode === 'read' ? (this.position.readCursor ?? this.position.readLines?.length) || null : this.position.lineIndex,
          selections: this.mode === 'read' ? [] : this.position.selections,
          onVnodeMounted:() => { decorate(); Promise.resolve().then(() => host.querySelector?.('[data-active-line="exact"]')?.scrollIntoView({block:'center'})); },
          onVnodeUpdated:decorate,
          'onUpdate:show': show => { if (!show) onClose(); }
        })] }); }
      });
      const view = app.mount(host);
      view.position = position;
      const select = event => {
        if (view.mode !== 'read' || !onSeek || (event.type === 'keydown' && !['Enter',' '].includes(event.key))) return;
        if (host.ownerDocument?.getSelection?.()?.toString()) return;
        const row = event.target?.closest?.('[data-arkstage-log-index]');
        const index = Number(row?.getAttribute('data-arkstage-log-index'));
        if (!row || !host.contains(row) || !Number.isInteger(index) || index < 1 || index > view.position.readLines.length) return;
        event.preventDefault(); event.stopPropagation(); onSeek(index - 1);
      };
      host.addEventListener?.('click', select); host.addEventListener?.('keydown', select);
      return { update(next) { view.position = next; }, dispose() {
        host.removeEventListener?.('click', select); host.removeEventListener?.('keydown', select); app.unmount();
      } };
    },` : ""}
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
