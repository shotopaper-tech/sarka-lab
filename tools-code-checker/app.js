const NJOS = {
    name: "NJOS",
    version: "0.8.0",
    status: "online"
};

class Store {
    constructor() {
        this.state = {
            activeView: "world",
            systemState: "ONLINE",
            companionState: "ACTIVE",
            parser: "Acorn",
            issuesCount: 0,
            lastAnalysis: null,
            analysisStatus: "READY"
        };

        this.listeners = new Set();
    }

    get(key) {
        return this.state[key];
    }

    set(key, value) {
        const previous = this.state[key];
        this.state[key] = value;

        for (const listener of this.listeners) {
            listener(key, value, previous);
        }
    }

    subscribe(listener) {
        this.listeners.add(listener);

        return () => {
            this.listeners.delete(listener);
        };
    }
}

class NexusCore {
    constructor() {
        this.listeners = new Map();
        this.tools = new Map();
        this.state = new Map();
        this.history = [];
        this.context = new Map();
        this.maxHistory = 500;
    }

    on(event, handler) {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set());
        }

        this.listeners.get(event).add(handler);

        return () => {
            this.listeners.get(event)?.delete(handler);
        };
    }

    once(event, handler) {
        const off = this.on(event, (...args) => {
            off();
            handler(...args);
        });

        return off;
    }

    emit(event, payload = {}) {
        const record = {
            event,
            payload,
            timestamp: Date.now()
        };

        this.history.push(record);

        if (this.history.length > this.maxHistory) {
            this.history.shift();
        }

        const handlers = this.listeners.get(event);

        if (handlers) {
            for (const handler of handlers) {
                handler(payload, record);
            }
        }

        const wildcard = this.listeners.get("*");

        if (wildcard) {
            for (const handler of wildcard) {
                handler(payload, record);
            }
        }

        return record;
    }

    registerTool(name, tool) {
        this.tools.set(name, tool);

        this.emit("tool:registered", {
            name
        });

        return tool;
    }

    getTool(name) {
        return this.tools.get(name);
    }

    setState(key, value) {
        const previous = this.state.get(key);

        this.state.set(key, value);

        this.emit("state:changed", {
            key,
            previous,
            value
        });

        return value;
    }

    getState(key) {
        return this.state.get(key);
    }

    setContext(key, value) {
        this.context.set(key, value);

        this.emit("context:changed", {
            key,
            value
        });

        return value;
    }

    getContext(key) {
        return this.context.get(key);
    }

    getAllContext() {
        return Object.fromEntries(this.context);
    }

    getHistory(limit = 50) {
        return this.history.slice(-limit);
    }

    clearContext() {
        this.context.clear();
        this.emit("context:cleared");
    }
}

class LeftBrain {
    constructor(nexus) {
        this.nexus = nexus;
        this.adapters = new Map();
    }

    registerAdapter(name, adapter) {
        this.adapters.set(name, adapter);

        this.nexus.emit("adapter:registered", {
            name
        });
    }

    normalize(input, metadata = {}) {
        const normalized = {
            source: typeof input === "string"
                ? input
                : String(input ?? ""),
            language: metadata.language || "javascript",
            sourceType: metadata.sourceType || "script",
            origin: metadata.origin || "unknown",
            timestamp: Date.now()
        };

        this.nexus.emit("input:normalized", normalized);

        return normalized;
    }

    async adapt(input, name, context = {}) {
        const adapter = this.adapters.get(name);

        if (!adapter) {
            throw new Error(`Adapter "${name}" tidak ditemukan.`);
        }

        const result = typeof adapter === "function"
            ? await adapter(input, context)
            : await adapter.transform(input, context);

        this.nexus.emit("input:adapted", {
            adapter: name,
            result
        });

        return result;
    }
}

class RearBrain {
    constructor(nexus) {
        this.nexus = nexus;
        this.context = new Map();
        this.memory = [];
        this.errors = [];

        this.nexus.on("*", (payload, record) => {
            if (
                record.event !== "memory:stored" &&
                record.event !== "context:changed"
            ) {
                this.memory.push(record);

                if (this.memory.length > 500) {
                    this.memory.shift();
                }
            }
        });
    }

    setContext(key, value) {
        this.context.set(key, value);

        this.nexus.emit("context:changed", {
            key,
            value
        });

        return value;
    }

    getContext(key) {
        return this.context.get(key);
    }

    getAllContext() {
        return Object.fromEntries(this.context);
    }

    rememberError(error, source = "unknown") {
        const record = {
            source,
            message: error?.message || String(error),
            stack: error?.stack || null,
            timestamp: Date.now()
        };

        this.errors.push(record);

        if (this.errors.length > 200) {
            this.errors.shift();
        }

        this.nexus.emit("error:remembered", record);

        return record;
    }

    getMemory(limit = 50) {
        return this.memory.slice(-limit);
    }

    getErrors(limit = 50) {
        return this.errors.slice(-limit);
    }

    clear() {
        this.context.clear();
        this.memory.length = 0;
        this.errors.length = 0;

        this.nexus.emit("memory:cleared");
    }
}

class RightBrain {
    constructor(nexus) {
        this.nexus = nexus;
        this.analyzers = new Map();
        this.validators = new Map();
    }

    registerAnalyzer(name, analyzer) {
        this.analyzers.set(name, analyzer);

        this.nexus.emit("analyzer:registered", {
            name
        });
    }

    registerValidator(name, validator) {
        this.validators.set(name, validator);

        this.nexus.emit("validator:registered", {
            name
        });
    }

    async analyze(name, input, context = {}) {
        const analyzer = this.analyzers.get(name);

        if (!analyzer) {
            throw new Error(`Analyzer "${name}" tidak ditemukan.`);
        }

        this.nexus.emit("analysis:start", {
            analyzer: name
        });

        try {
            const result = typeof analyzer === "function"
                ? await analyzer(input, context)
                : await analyzer.analyze(input, context);

            this.nexus.emit("analysis:completed", {
                analyzer: name,
                result
            });

            return result;
        } catch (error) {
            this.nexus.emit("analysis:failed", {
                analyzer: name,
                error: error.message
            });

            throw error;
        }
    }

    async validate(name, data, context = {}) {
        const validator = this.validators.get(name);

        if (!validator) {
            throw new Error(`Validator "${name}" tidak ditemukan.`);
        }

        return typeof validator === "function"
            ? validator(data, context)
            : validator.validate(data, context);
    }
}

class FrontalBrain {
    constructor(nexus) {
        this.nexus = nexus;
        this.workflows = new Map();
    }

    registerWorkflow(name, workflow) {
        this.workflows.set(name, workflow);

        this.nexus.emit("workflow:registered", {
            name
        });
    }

    async execute(name, payload = {}) {
        const workflow = this.workflows.get(name);

        if (!workflow) {
            throw new Error(`Workflow "${name}" tidak ditemukan.`);
        }

        this.nexus.emit("decision:made", {
            action: name
        });

        this.nexus.emit("workflow:start", {
            action: name
        });

        try {
            const result = typeof workflow === "function"
                ? await workflow(payload)
                : await workflow.execute(payload);

            this.nexus.emit("workflow:completed", {
                action: name,
                result
            });

            return result;
        } catch (error) {
            this.nexus.emit("workflow:failed", {
                action: name,
                error: error.message
            });

            throw error;
        }
    }
}

class Nexus {
    constructor() {
        this.core = new NexusCore();
        this.left = new LeftBrain(this);
        this.rear = new RearBrain(this);
        this.right = new RightBrain(this);
        this.frontal = new FrontalBrain(this);

        this.core.on("*", () => {});

        this.emit("nexus:boot", {
            version: "0.8.0",
            parts: [
                "core",
                "left",
                "right",
                "frontal",
                "rear"
            ]
        });
    }

    on(event, handler) {
        return this.core.on(event, handler);
    }

    once(event, handler) {
        return this.core.once(event, handler);
    }

    emit(event, payload = {}) {
        return this.core.emit(event, payload);
    }

    registerTool(name, tool) {
        return this.core.registerTool(name, tool);
    }

    getTool(name) {
        return this.core.getTool(name);
    }

    setState(key, value) {
        return this.core.setState(key, value);
    }

    getState(key) {
        return this.core.getState(key);
    }

    setContext(key, value) {
        return this.rear.setContext(key, value);
    }

    getContext(key) {
        return this.rear.getContext(key);
    }

    async request(action, payload = {}) {
        return this.frontal.execute(action, payload);
    }
}

class SymbolRecord {
    constructor(name, type, node, scope) {
        this.name = name;
        this.type = type;
        this.node = node;
        this.scope = scope;
        this.references = [];
        this.declarations = 1;
    }
}

class Scope {
    constructor(parent = null, type = "block") {
        this.parent = parent;
        this.type = type;
        this.symbols = new Map();
        this.children = [];
    }

    define(name, type, node) {
        if (!this.symbols.has(name)) {
            this.symbols.set(
                name,
                new SymbolRecord(name, type, node, this)
            );
        }

        return this.symbols.get(name);
    }

    resolve(name) {
        if (this.symbols.has(name)) {
            return this.symbols.get(name);
        }

        return this.parent?.resolve(name) || null;
    }
}

class ScopeResolver {
    constructor(ast) {
        this.ast = ast;
        this.root = new Scope(null, "program");
        this.current = this.root;
        this.references = [];
    }

    resolve() {
        this.visit(this.ast);
        return this.root;
    }

    push(type) {
        const scope = new Scope(this.current, type);

        this.current.children.push(scope);
        this.current = scope;

        return scope;
    }

    pop() {
        this.current = this.current.parent || this.current;
    }

    definePattern(pattern, type) {
        if (!pattern) {
            return;
        }

        if (pattern.type === "Identifier") {
            this.current.define(pattern.name, type, pattern);
            return;
        }

        if (
            pattern.type === "AssignmentPattern" ||
            pattern.type === "RestElement"
        ) {
            this.definePattern(pattern.left || pattern.argument, type);
            return;
        }

        if (pattern.type === "ArrayPattern") {
            for (const element of pattern.elements) {
                this.definePattern(element, type);
            }

            return;
        }

        if (pattern.type === "ObjectPattern") {
            for (const property of pattern.properties) {
                if (property.type === "RestElement") {
                    this.definePattern(property.argument, type);
                } else {
                    this.definePattern(property.value, type);
                }
            }
        }
    }

    visit(node) {
        if (!node || typeof node !== "object") {
            return;
        }

        switch (node.type) {
            case "Program":
                for (const statement of node.body) {
                    this.visit(statement);
                }
                break;

            case "VariableDeclaration":
                for (const declaration of node.declarations) {
                    this.definePattern(
                        declaration.id,
                        node.kind
                    );

                    if (declaration.init) {
                        this.visit(declaration.init);
                    }
                }
                break;

            case "FunctionDeclaration":
                if (node.id) {
                    this.current.define(
                        node.id.name,
                        "function",
                        node.id
                    );
                }

                this.push("function");

                for (const param of node.params) {
                    this.definePattern(param, "parameter");
                }

                this.visit(node.body);
                this.pop();
                break;

            case "FunctionExpression":
            case "ArrowFunctionExpression":
                this.push("function");

                if (node.id) {
                    this.current.define(
                        node.id.name,
                        "function",
                        node.id
                    );
                }

                for (const param of node.params) {
                    this.definePattern(param, "parameter");
                }

                this.visit(node.body);
                this.pop();
                break;

            case "BlockStatement":
                this.push("block");

                for (const statement of node.body) {
                    this.visit(statement);
                }

                this.pop();
                break;

            case "ClassDeclaration":
                if (node.id) {
                    this.current.define(
                        node.id.name,
                        "class",
                        node.id
                    );
                }

                this.push("class");

                if (node.superClass) {
                    this.visit(node.superClass);
                }

                this.visit(node.body);
                this.pop();
                break;

            case "ClassBody":
                for (const element of node.body) {
                    this.visit(element);
                }
                break;

            case "MethodDefinition":
                this.visit(node.value);
                break;

            case "IfStatement":
                this.visit(node.test);
                this.visit(node.consequent);

                if (node.alternate) {
                    this.visit(node.alternate);
                }
                break;

            case "ForStatement":
                this.push("loop");

                this.visit(node.init);
                this.visit(node.test);
                this.visit(node.update);
                this.visit(node.body);

                this.pop();
                break;

            case "ForInStatement":
            case "ForOfStatement":
                this.push("loop");

                this.visit(node.left);
                this.visit(node.right);
                this.visit(node.body);

                this.pop();
                break;

            case "WhileStatement":
            case "DoWhileStatement":
                this.visit(node.test);
                this.visit(node.body);
                break;

            case "SwitchStatement":
                this.visit(node.discriminant);

                this.push("switch");

                for (const branch of node.cases) {
                    this.visit(branch);
                }

                this.pop();
                break;

            case "SwitchCase":
                this.visit(node.test);

                for (const statement of node.consequent) {
                    this.visit(statement);
                }
                break;

            case "TryStatement":
                this.visit(node.block);

                if (node.handler) {
                    this.visit(node.handler);
                }

                if (node.finalizer) {
                    this.visit(node.finalizer);
                }
                break;

            case "CatchClause":
                this.push("catch");

                this.definePattern(
                    node.param,
                    "catch"
                );

                this.visit(node.body);

                this.pop();
                break;

            case "Identifier":
                this.references.push({
                    name: node.name,
                    node,
                    scope: this.current
                });
                break;

            case "MemberExpression":
                this.visit(node.object);

                if (node.computed) {
                    this.visit(node.property);
                }
                break;

            case "Property":
                if (node.computed) {
                    this.visit(node.key);
                }

                this.visit(node.value);
                break;

            case "ObjectExpression":
                for (const property of node.properties) {
                    this.visit(property);
                }
                break;

            case "ArrayExpression":
                for (const element of node.elements) {
                    this.visit(element);
                }
                break;

            case "CallExpression":
            case "NewExpression":
                this.visit(node.callee);

                for (const argument of node.arguments) {
                    this.visit(argument);
                }
                break;

            case "AssignmentExpression":
                this.visit(node.left);
                this.visit(node.right);
                break;

            case "BinaryExpression":
            case "LogicalExpression":
                this.visit(node.left);
                this.visit(node.right);
                break;

            case "UnaryExpression":
            case "UpdateExpression":
            case "AwaitExpression":
            case "YieldExpression":
                this.visit(node.argument);
                break;

            case "ConditionalExpression":
                this.visit(node.test);
                this.visit(node.consequent);
                this.visit(node.alternate);
                break;

            case "TemplateLiteral":
                for (const expression of node.expressions) {
                    this.visit(expression);
                }
                break;

            case "SequenceExpression":
                for (const expression of node.expressions) {
                    this.visit(expression);
                }
                break;

            default:
                for (const key of Object.keys(node)) {
                    if (
                        key === "loc" ||
                        key === "start" ||
                        key === "end"
                    ) {
                        continue;
                    }

                    const value = node[key];

                    if (Array.isArray(value)) {
                        for (const item of value) {
                            if (item && typeof item.type === "string") {
                                this.visit(item);
                            }
                        }
                    } else if (
                        value &&
                        typeof value.type === "string"
                    ) {
                        this.visit(value);
                    }
                }
        }
    }
}

class TypoDetector {
    distance(a, b) {
        const matrix = Array.from(
            { length: a.length + 1 },
            () => Array(b.length + 1).fill(0)
        );

        for (let i = 0; i <= a.length; i++) {
            matrix[i][0] = i;
        }

        for (let j = 0; j <= b.length; j++) {
            matrix[0][j] = j;
        }

        for (let i = 1; i <= a.length; i++) {
            for (let j = 1; j <= b.length; j++) {
                const cost = a[i - 1] === b[j - 1] ? 0 : 1;

                matrix[i][j] = Math.min(
                    matrix[i - 1][j] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j - 1] + cost
                );
            }
        }

        return matrix[a.length][b.length];
    }

    similarity(a, b) {
        if (!a.length && !b.length) {
            return 1;
        }

        const distance = this.distance(a, b);

        return 1 - distance / Math.max(a.length, b.length);
    }

    find(name, candidates) {
        let best = null;
        let score = 0;

        for (const candidate of candidates) {
            const current = this.similarity(
                name,
                candidate
            );

            if (current > score) {
                score = current;
                best = candidate;
            }
        }

        if (score >= 0.72) {
            return {
                name: best,
                score
            };
        }

        return null;
    }
}

class SemanticAnalyzer {
    constructor() {
        this.typoDetector = new TypoDetector();
    }

    analyze(ast) {
        const resolver = new ScopeResolver(ast);
        const root = resolver.resolve();

        const issues = [];
        const allSymbols = [];

        this.collectSymbols(root, allSymbols);

        const names = allSymbols.map(symbol => symbol.name);

        for (const reference of resolver.references) {
            const symbol = reference.scope.resolve(
                reference.name
            );

            if (symbol) {
                symbol.references.push(reference.node);
                continue;
            }

            const typo = this.typoDetector.find(
                reference.name,
                names
            );

            if (typo) {
                issues.push({
                    type: "typo",
                    severity: "warning",
                    message: `Possible typo: "${reference.name}" → "${typo.name}"`,
                    line: reference.node.loc?.start.line || 0,
                    column: reference.node.loc?.start.column || 0,
                    confidence: typo.score
                });
            } else {
                issues.push({
                    type: "undeclared",
                    severity: "error",
                    message: `"${reference.name}" is not defined`,
                    line: reference.node.loc?.start.line || 0,
                    column: reference.node.loc?.start.column || 0,
                    confidence: 1
                });
            }
        }

        for (const symbol of allSymbols) {
            if (
                symbol.references.length === 0 &&
                symbol.type !== "parameter"
            ) {
                issues.push({
                    type: "unused",
                    severity: "info",
                    message: `"${symbol.name}" is declared but never used`,
                    line: symbol.node.loc?.start.line || 0,
                    column: symbol.node.loc?.start.column || 0,
                    confidence: 0.95
                });
            }
        }

        return {
            issues,
            symbols: allSymbols.map(symbol => ({
                name: symbol.name,
                type: symbol.type,
                references: symbol.references.length,
                line: symbol.node.loc?.start.line || 0
            }))
        };
    }

    collectSymbols(scope, output) {
        for (const symbol of scope.symbols.values()) {
            output.push(symbol);
        }

        for (const child of scope.children) {
            this.collectSymbols(child, output);
        }
    }
}

class CodeAnalyzer {
    constructor() {
        this.semantic = new SemanticAnalyzer();
    }

    async analyze(input) {
        if (!window.acorn) {
            throw new Error("Acorn parser tidak tersedia.");
        }

        const source = input.source;

        let ast;

        try {
            ast = window.acorn.parse(source, {
                ecmaVersion: "latest",
                sourceType: input.sourceType || "script",
                locations: true,
                allowAwaitOutsideFunction: true,
                allowReturnOutsideFunction: true
            });
        } catch (error) {
            return {
                parser: "Acorn",
                success: false,
                issues: [
                    {
                        type: "syntax",
                        severity: "error",
                        message: error.message,
                        line: error.loc?.line || 0,
                        column: error.loc?.column || 0,
                        confidence: 1
                    }
                ],
                symbols: []
            };
        }

        const semantic = this.semantic.analyze(ast);

        return {
            parser: "Acorn",
            success: true,
            issues: semantic.issues,
            symbols: semantic.symbols,
            ast
        };
    }
}

const store = new Store();
const nexus = new Nexus();
const codeAnalyzer = new CodeAnalyzer();

nexus.registerTool(
    "code-analyzer",
    codeAnalyzer
);

nexus.right.registerAnalyzer(
    "code-analyzer",
    codeAnalyzer
);

nexus.frontal.registerWorkflow(
    "analyze",
    async payload => {
        const input = nexus.left.normalize(
            payload.source,
            {
                language: payload.language || "javascript",
                sourceType: "script",
                origin: "code-editor"
            }
        );

        nexus.rear.setContext(
            "lastInput",
            input
        );

        const result = await nexus.right.analyze(
            "code-analyzer",
            input
        );

        nexus.rear.setContext(
            "lastAnalysis",
            result
        );

        return result;
    }
);

nexus.frontal.registerWorkflow(
    "clear",
    async () => {
        nexus.rear.clear();

        store.set(
            "issuesCount",
            0
        );

        store.set(
            "lastAnalysis",
            null
        );

        store.set(
            "analysisStatus",
            "READY"
        );

        return {
            success: true
        };
    }
);

const $ = id => document.getElementById(id);

const elements = {
    workspaceTitle: $("workspaceTitle"),
    nexusMessage: $("nexusMessage"),
    codeEditor: $("codeEditor"),
    analysisOutput: $("analysisOutput"),
    editorLanguage: $("editorLanguage"),
    analysisState: $("analysisState"),
    analyzerContent: $("analyzerContent"),
    variableContent: $("variableContent"),
    runtimeState: $("runtimeState"),
    runtimeCompanion: $("runtimeCompanion"),
    runtimeNexus: $("runtimeNexus"),
    runtimeParser: $("runtimeParser"),
    runtimeAnalysis: $("runtimeAnalysis"),
    runtimeIssues: $("runtimeIssues"),
    nexusStreamStatus: $("nexusStreamStatus"),
    eventList: $("eventList"),
    systemNjos: $("systemNjos"),
    systemNexus: $("systemNexus"),
    systemParser: $("systemParser"),
    systemCompanion: $("systemCompanion"),
    systemBox: $("systemBox"),
    worldLocation: $("worldLocation"),
    companionStatus: $("companionStatus"),
    worldNexusStatus: $("worldNexusStatus"),
    njosStatus: $("njosStatus"),
    systemState: $("systemState"),
    analyzeButton: $("analyzeButton"),
    clearButton: $("clearButton"),
    worldCanvas: $("worldCanvas"),
    companionCanvas: $("companionCanvas"),
    companionShadow: $("companionShadow")
};

function safeText(element, value) {
    if (element) {
        element.textContent = value;
    }
}

function renderEvent(event, payload) {
    if (!elements.eventList) {
        return;
    }

    const item = document.createElement("div");

    item.className = "event-item";

    const time = new Date().toLocaleTimeString();

    item.textContent =
        `[${time}] ${event}`;

    elements.eventList.prepend(item);

    while (elements.eventList.children.length > 40) {
        elements.eventList.lastElementChild.remove();
    }
}

nexus.on("*", (payload, record) => {
    renderEvent(
        record.event,
        payload
    );

    safeText(
        elements.nexusStreamStatus,
        "STREAMING"
    );
});

nexus.on("analysis:start", () => {
    store.set(
        "analysisStatus",
        "ANALYZING"
    );

    safeText(
        elements.analysisState,
        "ANALYZING"
    );

    safeText(
        elements.nexusMessage,
        "Nexus sedang menganalisis source..."
    );
});

nexus.on("analysis:completed", ({ result }) => {
    const count = result.issues?.length || 0;

    store.set(
        "issuesCount",
        count
    );

    store.set(
        "lastAnalysis",
        result
    );

    store.set(
        "analysisStatus",
        "COMPLETE"
    );

    renderAnalysis(result);
    renderAnalyzer(result);
    renderVariables(result);
    renderRuntime(result);

    safeText(
        elements.nexusMessage,
        count === 0
            ? "Analysis selesai. Tidak ditemukan issue."
            : `Analysis selesai. ${count} issue ditemukan.`
    );

    safeText(
        elements.analysisState,
        "COMPLETE"
    );
});

nexus.on("analysis:failed", ({ error }) => {
    store.set(
        "analysisStatus",
        "FAILED"
    );

    safeText(
        elements.analysisState,
        "FAILED"
    );

    safeText(
        elements.nexusMessage,
        error
    );
});

nexus.on("nexus:boot", () => {
    safeText(
        elements.njosStatus,
        "ONLINE"
    );

    safeText(
        elements.systemState,
        "ONLINE"
    );

    safeText(
        elements.systemNjos,
        "ONLINE"
    );

    safeText(
        elements.systemNexus,
        "ONLINE"
    );

    safeText(
        elements.systemParser,
        "ACORN"
    );

    safeText(
        elements.systemCompanion,
        "ACTIVE"
    );
});

function renderAnalysis(result) {
    if (!elements.analysisOutput) {
        return;
    }

    elements.analysisOutput.innerHTML = "";

    if (!result.success) {
        for (const issue of result.issues) {
            appendIssue(
                elements.analysisOutput,
                issue
            );
        }

        return;
    }

    if (!result.issues.length) {
        const empty = document.createElement("div");

        empty.className = "analysis-empty";
        empty.textContent = "No issues detected.";

        elements.analysisOutput.appendChild(
            empty
        );

        return;
    }

    for (const issue of result.issues) {
        appendIssue(
            elements.analysisOutput,
            issue
        );
    }
}

function appendIssue(container, issue) {
    const item = document.createElement("div");

    item.className = "analysis-issue";

    const severity = document.createElement("strong");

    severity.textContent =
        issue.severity.toUpperCase();

    const message = document.createElement("span");

    message.textContent =
        issue.message;

    const location = document.createElement("small");

    location.textContent =
        `Line ${issue.line}, Column ${issue.column}`;

    item.append(
        severity,
        message,
        location
    );

    container.appendChild(item);
}

function renderAnalyzer(result) {
    if (!elements.analyzerContent) {
        return;
    }

    elements.analyzerContent.innerHTML = "";

    const data = [
        ["Parser", result.parser],
        ["Success", result.success ? "YES" : "NO"],
        ["Issues", result.issues.length],
        ["Symbols", result.symbols.length]
    ];

    for (const [label, value] of data) {
        const row = document.createElement("div");

        row.className = "info-row";

        const key = document.createElement("span");
        key.textContent = label;

        const val = document.createElement("strong");
        val.textContent = value;

        row.append(
            key,
            val
        );

        elements.analyzerContent.appendChild(row);
    }
}

function renderVariables(result) {
    if (!elements.variableContent) {
        return;
    }

    elements.variableContent.innerHTML = "";

    if (!result.symbols.length) {
        elements.variableContent.textContent =
            "No symbols detected.";

        return;
    }

    for (const symbol of result.symbols) {
        const row = document.createElement("div");

        row.className = "variable-row";

        row.innerHTML = `
            <span>${escapeHtml(symbol.name)}</span>
            <span>${escapeHtml(symbol.type)}</span>
            <span>${symbol.references}</span>
        `;

        elements.variableContent.appendChild(row);
    }
}

function renderRuntime(result) {
    safeText(
        elements.runtimeState,
        result.success ? "STABLE" : "ERROR"
    );

    safeText(
        elements.runtimeCompanion,
        "ACTIVE"
    );

    safeText(
        elements.runtimeNexus,
        "ROUTING"
    );

    safeText(
        elements.runtimeParser,
        result.parser
    );

    safeText(
        elements.runtimeAnalysis,
        result.success
            ? "COMPLETE"
            : "FAILED"
    );

    safeText(
        elements.runtimeIssues,
        String(result.issues.length)
    );
}

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

async function analyzeCode() {
    const source =
        elements.codeEditor?.value || "";

    const language =
        elements.editorLanguage?.value ||
        "javascript";

    if (!source.trim()) {
        safeText(
            elements.nexusMessage,
            "Editor masih kosong."
        );

        return;
    }

    try {
        await nexus.request(
            "analyze",
            {
                source,
                language
            }
        );
    } catch (error) {
        nexus.rear.rememberError(
            error,
            "analyze"
        );

        safeText(
            elements.nexusMessage,
            error.message
        );
    }
}

async function clearWorkspace() {
    await nexus.request("clear");

    if (elements.analysisOutput) {
        elements.analysisOutput.innerHTML = "";
    }

    if (elements.analyzerContent) {
        elements.analyzerContent.innerHTML = "";
    }

    if (elements.variableContent) {
        elements.variableContent.innerHTML = "";
    }

    safeText(
        elements.analysisState,
        "READY"
    );

    safeText(
        elements.nexusMessage,
        "Workspace dibersihkan."
    );

    safeText(
        elements.runtimeIssues,
        "0"
    );
}

function activateView(view) {
    store.set(
        "activeView",
        view
    );

    const views = document.querySelectorAll(
        "[data-view]"
    );

    for (const item of views) {
        item.classList.toggle(
            "active",
            item.dataset.view === view
        );
    }

    const panels = document.querySelectorAll(
        "[data-panel]"
    );

    for (const panel of panels) {
        panel.hidden =
            panel.dataset.panel !== view;
    }

    const titles = {
        world: "World",
        editor: "Code Editor",
        analyzer: "Analyzer",
        variables: "Variable Manager",
        runtime: "Runtime Monitor",
        nexus: "Nexus"
    };

    safeText(
        elements.workspaceTitle,
        titles[view] || "Cakrawala"
    );

    nexus.emit(
        "view:changed",
        {
            view
        }
    );
}

function setupNavigation() {
    document
        .querySelectorAll("[data-view]")
        .forEach(item => {
            item.addEventListener(
                "click",
                () => {
                    activateView(
                        item.dataset.view
                    );
                }
            );
        });
}

function setupButtons() {
    elements.analyzeButton?.addEventListener(
        "click",
        analyzeCode
    );

    elements.clearButton?.addEventListener(
        "click",
        clearWorkspace
    );
}

function setupEditor() {
    elements.codeEditor?.addEventListener(
        "input",
        () => {
            nexus.emit(
                "editor:changed",
                {
                    length:
                        elements.codeEditor.value.length
                }
            );
        }
    );
}

function setupWorld() {
    const canvas = elements.worldCanvas;

    if (!canvas) {
        return;
    }

    const context =
        canvas.getContext("2d");

    let x = canvas.width / 2;
    let y = canvas.height / 2;

    let targetX = x;
    let targetY = y;

    function randomTarget() {
        targetX =
            30 +
            Math.random() *
            (canvas.width - 60);

        targetY =
            60 +
            Math.random() *
            (canvas.height - 90);
    }

    randomTarget();

    function draw() {
        context.clearRect(
            0,
            0,
            canvas.width,
            canvas.height
        );

        x += (targetX - x) * 0.015;
        y += (targetY - y) * 0.015;

        context.fillStyle = "#111";

        context.beginPath();

        context.arc(
            x,
            y,
            8,
            0,
            Math.PI * 2
        );

        context.fill();

        if (
            Math.abs(targetX - x) < 3 &&
            Math.abs(targetY - y) < 3
        ) {
            randomTarget();
        }

        requestAnimationFrame(draw);
    }

    draw();

    safeText(
        elements.worldLocation,
        "CAKRAWALA"
    );

    safeText(
        elements.companionStatus,
        "ACTIVE"
    );

    safeText(
        elements.worldNexusStatus,
        "CONNECTED"
    );
}

function setupCompanion() {
    const canvas =
        elements.companionCanvas;

    if (!canvas) {
        return;
    }

    const context =
        canvas.getContext("2d");

    let x = canvas.width / 2;
    let direction = 1;

    function draw() {
        context.clearRect(
            0,
            0,
            canvas.width,
            canvas.height
        );

        x += direction * 0.25;

        if (
            x > canvas.width - 25 ||
            x < 25
        ) {
            direction *= -1;
        }

        context.fillStyle = "#222";

        context.fillRect(
            x - 8,
            25,
            16,
            20
        );

        context.fillRect(
            x - 12,
            45,
            24,
            16
        );

        requestAnimationFrame(draw);
    }

    draw();
}

store.subscribe(
    (key, value) => {
        if (key === "issuesCount") {
            safeText(
                elements.runtimeIssues,
                String(value)
            );
        }
    }
);

setupNavigation();
setupButtons();
setupEditor();
setupWorld();
setupCompanion();

activateView("world");

safeText(
    elements.njosStatus,
    `${NJOS.name} ${NJOS.version}`
);

safeText(
    elements.systemState,
    "ONLINE"
);

nexus.emit(
    "system:ready",
    {
        njos: NJOS.version,
        nexus: "0.8.0"
    }
);
