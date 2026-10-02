const NJOS = {
    version: "0.6.0",
    globals: new Set([
        "console",
        "Math",
        "JSON",
        "Object",
        "Array",
        "String",
        "Number",
        "Boolean",
        "Date",
        "RegExp",
        "Promise",
        "Set",
        "Map",
        "Symbol",
        "Error",
        "TypeError",
        "parseInt",
        "parseFloat",
        "isNaN",
        "undefined",
        "NaN",
        "Infinity"
    ])
};

class CakrawalaNexus {
    constructor() {
        this.listeners = new Map();
        this.history = [];
    }

    on(event, callback) {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, []);
        }

        this.listeners.get(event).push(callback);
    }

    emit(event, data = {}) {
        const entry = {
            event,
            data,
            time: new Date().toLocaleTimeString()
        };

        this.history.unshift(entry);

        if (this.history.length > 100) {
            this.history.pop();
        }

        const listeners = this.listeners.get(event) || [];

        for (const callback of listeners) {
            callback(data, entry);
        }
    }
}

const Nexus = new CakrawalaNexus();

class SymbolRecord {
    constructor(name, kind, node, scope) {
        this.name = name;
        this.kind = kind;
        this.node = node;
        this.scope = scope;
        this.references = 0;
        this.line = node?.loc?.start?.line || 0;
        this.column = node?.loc?.start?.column || 0;
    }
}

class Scope {
    constructor(parent = null, type = "block") {
        this.parent = parent;
        this.type = type;
        this.symbols = new Map();
        this.children = [];
    }

    declare(name, kind, node) {
        if (!name) {
            return null;
        }

        if (!this.symbols.has(name)) {
            const record = new SymbolRecord(
                name,
                kind,
                node,
                this
            );

            this.symbols.set(name, record);
            return record;
        }

        return this.symbols.get(name);
    }

    resolve(name) {
        if (this.symbols.has(name)) {
            return this.symbols.get(name);
        }

        if (this.parent) {
            return this.parent.resolve(name);
        }

        return null;
    }

    functionScope() {
        let scope = this;

        while (scope.parent && scope.type !== "function") {
            scope = scope.parent;
        }

        return scope;
    }
}

class ScopeResolver {
    constructor(ast) {
        this.ast = ast;
        this.root = new Scope(null, "global");
        this.current = this.root;
        this.references = [];
        this.builtins = NJOS.globals;
    }

    addBuiltins() {
        for (const name of this.builtins) {
            this.root.declare(
                name,
                "builtin",
                {
                    loc: {
                        start: {
                            line: 0,
                            column: 0
                        }
                    }
                }
            );
        }
    }

    child(type = "block") {
        const scope = new Scope(this.current, type);

        this.current.children.push(scope);

        return scope;
    }

    withScope(scope, callback) {
        const previous = this.current;

        this.current = scope;

        callback();

        this.current = previous;
    }

    declarePattern(pattern, kind = "const") {
        if (!pattern) {
            return;
        }

        if (pattern.type === "Identifier") {
            const targetScope =
                kind === "var"
                    ? this.current.functionScope()
                    : this.current;

            targetScope.declare(
                pattern.name,
                kind,
                pattern
            );

            return;
        }

        if (
            pattern.type === "AssignmentPattern"
        ) {
            this.declarePattern(
                pattern.left,
                kind
            );

            this.expression(pattern.right);

            return;
        }

        if (
            pattern.type === "RestElement"
        ) {
            this.declarePattern(
                pattern.argument,
                kind
            );

            return;
        }

        if (
            pattern.type === "ArrayPattern"
        ) {
            for (const element of pattern.elements) {
                this.declarePattern(
                    element,
                    kind
                );
            }

            return;
        }

        if (
            pattern.type === "ObjectPattern"
        ) {
            for (const property of pattern.properties) {
                if (property.type === "RestElement") {
                    this.declarePattern(
                        property.argument,
                        kind
                    );
                    continue;
                }

                this.declarePattern(
                    property.value,
                    kind
                );
            }
        }
    }

    reference(identifier) {
        if (!identifier) {
            return;
        }

        const resolved = this.current.resolve(
            identifier.name
        );

        this.references.push({
            name: identifier.name,
            node: identifier,
            symbol: resolved
        });

        if (resolved) {
            resolved.references++;
        }
    }

    visitFunction(node) {
        const functionScope = this.child("function");

        this.withScope(
            functionScope,
            () => {
                if (
                    node.type === "FunctionDeclaration" &&
                    node.id
                ) {
                    functionScope.declare(
                        node.id.name,
                        "function",
                        node.id
                    );
                }

                for (const param of node.params) {
                    this.declarePattern(
                        param,
                        "parameter"
                    );
                }

                if (node.body.type === "BlockStatement") {
                    for (const statement of node.body.body) {
                        this.visit(statement);
                    }
                } else {
                    this.expression(node.body);
                }
            }
        );
    }

    visit(node) {
        if (!node) {
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
                    this.declarePattern(
                        declaration.id,
                        node.kind
                    );

                    if (declaration.init) {
                        this.expression(
                            declaration.init
                        );
                    }
                }
                break;

            case "FunctionDeclaration":
                if (node.id) {
                    this.current.declare(
                        node.id.name,
                        "function",
                        node.id
                    );
                }

                this.visitFunction(node);
                break;

            case "FunctionExpression":
            case "ArrowFunctionExpression":
                this.visitFunction(node);
                break;

            case "BlockStatement": {
                const block = this.child("block");

                this.withScope(
                    block,
                    () => {
                        for (const statement of node.body) {
                            this.visit(statement);
                        }
                    }
                );

                break;
            }

            case "ExpressionStatement":
                this.expression(node.expression);
                break;

            case "ReturnStatement":
                if (node.argument) {
                    this.expression(node.argument);
                }
                break;

            case "IfStatement":
                this.expression(node.test);
                this.visit(node.consequent);

                if (node.alternate) {
                    this.visit(node.alternate);
                }
                break;

            case "ForStatement":
                this.visitFor(node);
                break;

            case "ForInStatement":
            case "ForOfStatement":
                this.visitForInOf(node);
                break;

            case "WhileStatement":
            case "DoWhileStatement":
                this.expression(node.test);
                this.visit(node.body);
                break;

            case "SwitchStatement":
                this.expression(node.discriminant);

                for (const switchCase of node.cases) {
                    if (switchCase.test) {
                        this.expression(switchCase.test);
                    }

                    for (const statement of switchCase.consequent) {
                        this.visit(statement);
                    }
                }
                break;

            case "TryStatement":
                this.visit(node.block);

                if (node.handler) {
                    const catchScope = this.child("catch");

                    this.withScope(
                        catchScope,
                        () => {
                            if (node.handler.param) {
                                this.declarePattern(
                                    node.handler.param,
                                    "catch"
                                );
                            }

                            this.visit(node.handler.body);
                        }
                    );
                }

                if (node.finalizer) {
                    this.visit(node.finalizer);
                }
                break;

            case "ThrowStatement":
                this.expression(node.argument);
                break;

            case "ClassDeclaration":
                if (node.id) {
                    this.current.declare(
                        node.id.name,
                        "class",
                        node.id
                    );
                }

                if (node.superClass) {
                    this.expression(
                        node.superClass
                    );
                }

                this.visitClassBody(node.body);
                break;

            case "LabeledStatement":
                this.visit(node.body);
                break;

            case "WithStatement":
                this.expression(node.object);
                this.visit(node.body);
                break;

            case "DebuggerStatement":
            case "BreakStatement":
            case "ContinueStatement":
                break;

            default:
                this.generic(node);
        }
    }

    visitFor(node) {
        const scope = this.child("block");

        this.withScope(
            scope,
            () => {
                if (node.init) {
                    if (
                        node.init.type ===
                        "VariableDeclaration"
                    ) {
                        this.visit(node.init);
                    } else {
                        this.expression(node.init);
                    }
                }

                if (node.test) {
                    this.expression(node.test);
                }

                if (node.update) {
                    this.expression(node.update);
                }

                this.visit(node.body);
            }
        );
    }

    visitForInOf(node) {
        const scope = this.child("block");

        this.withScope(
            scope,
            () => {
                if (node.left) {
                    if (
                        node.left.type ===
                        "VariableDeclaration"
                    ) {
                        this.visit(node.left);
                    } else {
                        this.expression(node.left);
                    }
                }

                this.expression(node.right);
                this.visit(node.body);
            }
        );
    }

    visitClassBody(body) {
        if (!body) {
            return;
        }

        for (const element of body.body) {
            if (element.value) {
                this.visitFunction(element.value);
            }
        }
    }

    expression(node) {
        if (!node) {
            return;
        }

        switch (node.type) {
            case "Identifier":
                this.reference(node);
                break;

            case "Literal":
                break;

            case "TemplateLiteral":
                for (const expression of node.expressions) {
                    this.expression(expression);
                }
                break;

            case "BinaryExpression":
            case "LogicalExpression":
            case "AssignmentExpression":
                this.expression(node.left);
                this.expression(node.right);
                break;

            case "UnaryExpression":
            case "UpdateExpression":
            case "AwaitExpression":
            case "YieldExpression":
                this.expression(node.argument);
                break;

            case "ConditionalExpression":
                this.expression(node.test);
                this.expression(node.consequent);
                this.expression(node.alternate);
                break;

            case "CallExpression":
            case "NewExpression":
                this.expression(node.callee);

                for (const argument of node.arguments) {
                    if (
                        argument.type ===
                        "SpreadElement"
                    ) {
                        this.expression(
                            argument.argument
                        );
                    } else {
                        this.expression(argument);
                    }
                }

                break;

            case "MemberExpression":
                this.expression(node.object);

                if (node.computed) {
                    this.expression(node.property);
                }

                break;

            case "ChainExpression":
                this.expression(node.expression);
                break;

            case "ArrayExpression":
                for (const element of node.elements) {
                    this.expression(element);
                }
                break;

            case "ObjectExpression":
                for (const property of node.properties) {
                    if (
                        property.type ===
                        "SpreadElement"
                    ) {
                        this.expression(
                            property.argument
                        );
                        continue;
                    }

                    if (property.computed) {
                        this.expression(
                            property.key
                        );
                    }

                    this.expression(
                        property.value
                    );
                }
                break;

            case "ArrowFunctionExpression":
            case "FunctionExpression":
                this.visitFunction(node);
                break;

            case "AssignmentPattern":
                this.expression(node.right);
                break;

            case "SequenceExpression":
                for (const expression of node.expressions) {
                    this.expression(expression);
                }
                break;

            case "ClassExpression":
                if (node.superClass) {
                    this.expression(
                        node.superClass
                    );
                }

                this.visitClassBody(node.body);
                break;

            default:
                this.generic(node);
        }
    }

    generic(node) {
        for (const key of Object.keys(node)) {
            if (
                key === "loc" ||
                key === "start" ||
                key === "end"
            ) {
                continue;
            }

            const value = node[key];

            if (!value) {
                continue;
            }

            if (Array.isArray(value)) {
                for (const child of value) {
                    if (
                        child &&
                        typeof child.type === "string"
                    ) {
                        if (
                            child.type === "Identifier"
                        ) {
                            this.reference(child);
                        } else {
                            this.visit(child);
                        }
                    }
                }
            } else if (
                typeof value === "object" &&
                typeof value.type === "string"
            ) {
                if (
                    value.type === "Identifier"
                ) {
                    this.reference(value);
                } else {
                    this.visit(value);
                }
            }
        }
    }

    resolve() {
        this.addBuiltins();
        this.visit(this.ast);

        return {
            root: this.root,
            references: this.references
        };
    }
}

class TypoDetector {
    distance(a, b) {
        const matrix = [];

        for (let i = 0; i <= b.length; i++) {
            matrix[i] = [i];
        }

        for (let j = 0; j <= a.length; j++) {
            matrix[0][j] = j;
        }

        for (let i = 1; i <= b.length; i++) {
            for (let j = 1; j <= a.length; j++) {
                if (b[i - 1] === a[j - 1]) {
                    matrix[i][j] =
                        matrix[i - 1][j - 1];
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1,
                        matrix[i][j - 1] + 1,
                        matrix[i - 1][j] + 1
                    );
                }
            }
        }

        return matrix[b.length][a.length];
    }

    similarity(a, b) {
        if (!a || !b) {
            return 0;
        }

        const distance = this.distance(
            a.toLowerCase(),
            b.toLowerCase()
        );

        return Math.max(
            0,
            1 - distance / Math.max(a.length, b.length)
        );
    }

    detect(name, candidates) {
        let best = null;
        let bestScore = 0;

        for (const candidate of candidates) {
            if (
                candidate === name ||
                candidate.length < 3
            ) {
                continue;
            }

            const score = this.similarity(
                name,
                candidate
            );

            if (
                score > bestScore &&
                score >= 0.72
            ) {
                bestScore = score;
                best = candidate;
            }
        }

        if (!best) {
            return null;
        }

        return {
            from: name,
            to: best,
            confidence: Math.round(
                bestScore * 100
            )
        };
    }
}

class Analyzer {
    constructor(ast, resolver) {
        this.ast = ast;
        this.resolver = resolver;
        this.typoDetector = new TypoDetector();
    }

    collectSymbols(scope, result = []) {
        for (const symbol of scope.symbols.values()) {
            if (symbol.kind !== "builtin") {
                result.push(symbol);
            }
        }

        for (const child of scope.children) {
            this.collectSymbols(
                child,
                result
            );
        }

        return result;
    }

    getUndeclared() {
        const results = [];

        for (const reference of this.resolver.references) {
            if (reference.symbol) {
                continue;
            }

            results.push(reference);
        }

        return results;
    }

    getUnused() {
        const symbols =
            this.collectSymbols(
                this.resolver.root
            );

        return symbols.filter(
            symbol =>
                symbol.references === 0 &&
                symbol.kind !== "parameter"
        );
    }

    getTypos(undeclared) {
        const symbols =
            this.collectSymbols(
                this.resolver.root
            );

        const names = symbols.map(
            symbol => symbol.name
        );

        const results = [];

        for (const reference of undeclared) {
            const suggestion =
                this.typoDetector.detect(
                    reference.name,
                    names
                );

            if (suggestion) {
                results.push({
                    ...suggestion,
                    node: reference.node
                });
            }
        }

        return results;
    }

    run() {
        const undeclared =
            this.getUndeclared();

        const typos =
            this.getTypos(undeclared);

        const typoNames = new Set(
            typos.map(item => item.from)
        );

        const filteredUndeclared =
            undeclared.filter(
                item => !typoNames.has(
                    item.name
                )
            );

        return {
            undeclared: filteredUndeclared,
            typos,
            unused: this.getUnused(),
            symbols: this.collectSymbols(
                this.resolver.root
            )
        };
    }
}

class CodeChecker {
    parse(code) {
        try {
            return {
                ast: acorn.parse(
                    code,
                    {
                        ecmaVersion: "latest",
                        sourceType: "script",
                        locations: true
                    }
                ),
                error: null
            };
        } catch (error) {
            return {
                ast: null,
                error
            };
        }
    }

    analyze(code) {
        const parsed = this.parse(code);

        if (parsed.error) {
            return {
                success: false,
                error: parsed.error
            };
        }

        const resolver =
            new ScopeResolver(
                parsed.ast
            );

        const resolved =
            resolver.resolve();

        const analyzer =
            new Analyzer(
                parsed.ast,
                resolved
            );

        return {
            success: true,
            ast: parsed.ast,
            rootScope: resolved.root,
            ...analyzer.run()
        };
    }
}

const checker = new CodeChecker();

const elements = {
    codeEditor:
        document.getElementById("codeEditor"),

    analysisOutput:
        document.getElementById("analysisOutput"),

    analyzerContent:
        document.getElementById("analyzerContent"),

    variableContent:
        document.getElementById("variableContent"),

    eventList:
        document.getElementById("eventList"),

    workspaceTitle:
        document.getElementById("workspaceTitle"),

    nexusMessage:
        document.getElementById("nexusMessage"),

    nexusStatus:
        document.getElementById("worldNexusStatus"),

    nexusStreamStatus:
        document.getElementById("nexusStreamStatus"),

    systemState:
        document.getElementById("systemState"),

    systemBox:
        document.getElementById("systemBox"),

    systemNjos:
        document.getElementById("systemNjos"),

    systemNexus:
        document.getElementById("systemNexus"),

    systemParser:
        document.getElementById("systemParser"),

    systemCompanion:
        document.getElementById("systemCompanion"),

    runtimeState:
        document.getElementById("runtimeState"),

    runtimeCompanion:
        document.getElementById("runtimeCompanion"),

    runtimeNexus:
        document.getElementById("runtimeNexus"),

    runtimeParser:
        document.getElementById("runtimeParser"),

    runtimeAnalysis:
        document.getElementById("runtimeAnalysis"),

    runtimeIssues:
        document.getElementById("runtimeIssues"),

    analysisState:
        document.getElementById("analysisState"),

    companionStatus:
        document.getElementById("companionStatus"),

    companionCanvas:
        document.getElementById("companionCanvas"),

    companionShadow:
        document.getElementById("companionShadow"),

    worldCanvas:
        document.getElementById("worldCanvas"),

    worldStage:
        document.getElementById("worldStage"),

    analyzeButton:
        document.getElementById("analyzeButton"),

    clearButton:
        document.getElementById("clearButton")
};

const companion = {
    x: 0,
    y: 0,
    direction: "down",
    frame: 0,
    timer: 0,
    moving: false,
    targetX: 0,
    targetY: 0,
    speed: 0.65,
    idleTimer: 0
};

const world = {
    width: 0,
    height: 0,
    time: 0
};

let lastResult = null;

function setMessage(message) {
    elements.nexusMessage.textContent =
        message;
}

function setSystemState(message) {
    elements.systemState.textContent =
        message;

    elements.systemBox.textContent =
        message;
}

function addEvent(message) {
    const event =
        document.createElement("div");

    event.className = "event";

    event.textContent =
        `[${new Date().toLocaleTimeString()}] ${message}`;

    elements.eventList.prepend(event);

    while (
        elements.eventList.children.length > 40
    ) {
        elements.eventList.lastElementChild.remove();
    }
}

function escapeHTML(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function formatIssue(type, title, detail) {
    return `
        <div class="issue ${type}">
            <div class="issue-title">
                ${escapeHTML(title)}
            </div>
            <div class="issue-detail">
                ${escapeHTML(detail)}
            </div>
        </div>
    `;
}

function renderAnalysis(result) {
    if (!result) {
        return;
    }

    if (!result.success) {
        const line =
            result.error.loc?.line || 0;

        const column =
            result.error.loc?.column || 0;

        const message =
            result.error.message || "Syntax error";

        const html =
            formatIssue(
                "error",
                "Syntax Error",
                `${message} at line ${line}, column ${column}.`
            );

        elements.analysisOutput.innerHTML =
            html;

        elements.analyzerContent.innerHTML =
            html;

        return;
    }

    const parts = [];

    for (const typo of result.typos) {
        parts.push(
            formatIssue(
                "warning",
                `Possible typo: ${typo.from}`,
                `Did you mean "${typo.to}"? Confidence ${typo.confidence}%.`
            )
        );
    }

    for (const issue of result.undeclared) {
        const line =
            issue.node?.loc?.start?.line || 0;

        parts.push(
            formatIssue(
                "error",
                `Undeclared variable: ${issue.name}`,
                `No declaration was resolved for this identifier at line ${line}.`
            )
        );
    }

    for (const symbol of result.unused) {
        parts.push(
            formatIssue(
                "warning",
                `Unused ${symbol.kind}: ${symbol.name}`,
                `Declared at line ${symbol.line}, but no reference was resolved.`
            )
        );
    }

    if (parts.length === 0) {
        parts.push(
            formatIssue(
                "ok",
                "Analysis clean",
                "No high-confidence issues were detected."
            )
        );
    }

    const html =
        parts.join("");

    elements.analysisOutput.innerHTML =
        html;

    elements.analyzerContent.innerHTML =
        html;
}

function renderVariables(result) {
    if (!result || !result.success) {
        return;
    }

    if (result.symbols.length === 0) {
        elements.variableContent.innerHTML =
            formatIssue(
                "ok",
                "No user symbols",
                "No declared variables or functions were found."
            );

        return;
    }

    const rows =
        result.symbols.map(symbol => {
            const references =
                symbol.references;

            return `
                <div class="issue">
                    <div class="issue-title">
                        ${escapeHTML(symbol.name)}
                    </div>

                    <div class="issue-detail">
                        ${escapeHTML(symbol.kind)}
                        · line ${symbol.line}
                        · ${references} reference${references === 1 ? "" : "s"}
                    </div>
                </div>
            `;
        });

    elements.variableContent.innerHTML =
        rows.join("");
}

function updateRuntime(result) {
    if (!result) {
        return;
    }

    const issueCount =
        result.success
            ? result.typos.length +
              result.undeclared.length +
              result.unused.length
            : 1;

    elements.runtimeState.textContent =
        result.success
            ? "Analysis complete"
            : "Syntax error";

    elements.runtimeIssues.textContent =
        String(issueCount);

    elements.runtimeParser.textContent =
        result.success
            ? "Acorn / AST"
            : "Acorn / error";

    elements.runtimeAnalysis.textContent =
        new Date().toLocaleTimeString();

    elements.systemParser.textContent =
        result.success
            ? "Acorn / AST"
            : "Acorn / Error";
}

function analyze() {
    const code =
        elements.codeEditor.value;

    setSystemState("ANALYZING");
    setMessage("Nexus analyzing source");

    elements.analysisState.textContent =
        "running";

    Nexus.emit(
        "analysis:start",
        {
            length: code.length
        }
    );

    const result =
        checker.analyze(code);

    lastResult = result;

    renderAnalysis(result);
    renderVariables(result);
    updateRuntime(result);

    if (result.success) {
        const issueCount =
            result.typos.length +
            result.undeclared.length +
            result.unused.length;

        elements.analysisState.textContent =
            issueCount === 0
                ? "clean"
                : `${issueCount} issue${issueCount === 1 ? "" : "s"}`;

        setSystemState(
            issueCount === 0
                ? "ANALYSIS CLEAN"
                : "ISSUES DETECTED"
        );

        setMessage(
            issueCount === 0
                ? "Nexus: source clean"
                : `Nexus: ${issueCount} issue detected`
        );

        Nexus.emit(
            "analysis:complete",
            {
                success: true,
                issues: issueCount
            }
        );
    } else {
        elements.analysisState.textContent =
            "syntax error";

        setSystemState(
            "SYNTAX ERROR"
        );

        setMessage(
            "Nexus: parser rejected source"
        );

        Nexus.emit(
            "analysis:error",
            {
                message:
                    result.error?.message ||
                    "Syntax error"
            }
        );
    }

    companionReactToAnalysis(
        result
    );
}

function clearAnalysis() {
    elements.analysisOutput.innerHTML =
        formatIssue(
            "ok",
            "Analysis cleared",
            "No current analysis result."
        );

    elements.analyzerContent.innerHTML =
        formatIssue(
            "ok",
            "Analyzer ready",
            "Run Analyze to inspect the current source."
        );

    elements.variableContent.innerHTML =
        formatIssue(
            "ok",
            "Symbol table cleared",
            "Run Analyze to rebuild the symbol table."
        );

    elements.analysisState.textContent =
        "waiting";

    elements.runtimeState.textContent =
        "Ready";

    elements.runtimeIssues.textContent =
        "0";

    elements.runtimeAnalysis.textContent =
        "None";

    setSystemState(
        "SYSTEM READY"
    );

    setMessage(
        "Cakrawala ready"
    );

    Nexus.emit(
        "analysis:clear"
    );
}

function setupTabs() {
    const tools =
        document.querySelectorAll(
            ".tool"
        );

    const views =
        document.querySelectorAll(
            ".view"
        );

    const titles = {
        world: "WORLD",
        editor: "CODE EDITOR",
        analyzer: "ANALYZER",
        variables: "VARIABLE MANAGER",
        runtime: "RUNTIME MONITOR",
        nexus: "NEXUS"
    };

    for (const tool of tools) {
        tool.addEventListener(
            "click",
            () => {
                const target =
                    tool.dataset.view;

                for (const item of tools) {
                    item.classList.toggle(
                        "active",
                        item === tool
                    );
                }

                for (const view of views) {
                    view.classList.toggle(
                        "active",
                        view.id ===
                        `view-${target}`
                    );
                }

                elements.workspaceTitle.textContent =
                    titles[target] ||
                    target.toUpperCase();

                Nexus.emit(
                    "view:change",
                    {
                        view: target
                    }
                );
            }
        );
    }
}

function drawWorld() {
    const canvas =
        elements.worldCanvas;

    if (!canvas) {
        return;
    }

    const context =
        canvas.getContext("2d");

    const rect =
        elements.worldStage.getBoundingClientRect();

    const ratio =
        window.devicePixelRatio || 1;

    canvas.width =
        Math.max(
            1,
            Math.floor(rect.width * ratio)
        );

    canvas.height =
        Math.max(
            1,
            Math.floor(rect.height * ratio)
        );

    canvas.style.width =
        `${rect.width}px`;

    canvas.style.height =
        `${rect.height}px`;

    context.setTransform(
        ratio,
        0,
        0,
        ratio,
        0,
        0
    );

    world.width =
        rect.width;

    world.height =
        rect.height;

    context.clearRect(
        0,
        0,
        rect.width,
        rect.height
    );

    const centerX =
        rect.width / 2;

    const centerY =
        rect.height / 2;

    context.strokeStyle =
        "rgba(54, 116, 185, 0.12)";

    context.lineWidth = 1;

    const roadWidth = 70;

    context.fillStyle =
        "rgba(18, 43, 72, 0.25)";

    context.fillRect(
        centerX - roadWidth / 2,
        0,
        roadWidth,
        rect.height
    );

    context.fillRect(
        0,
        centerY - roadWidth / 2,
        rect.width,
        roadWidth
    );

    context.strokeStyle =
        "rgba(65, 133, 201, 0.12)";

    context.beginPath();

    context.moveTo(
        centerX,
        0
    );

    context.lineTo(
        centerX,
        rect.height
    );

    context.moveTo(
        0,
        centerY
    );

    context.lineTo(
        rect.width,
        centerY
    );

    context.stroke();

    const nodes = [
        {
            x: centerX - 170,
            y: centerY - 90,
            label: "EDITOR"
        },
        {
            x: centerX + 170,
            y: centerY - 90,
            label: "ANALYZER"
        },
        {
            x: centerX - 170,
            y: centerY + 100,
            label: "VARIABLES"
        },
        {
            x: centerX + 170,
            y: centerY + 100,
            label: "RUNTIME"
        }
    ];

    for (const node of nodes) {
        context.fillStyle =
            "rgba(8, 24, 43, 0.9)";

        context.strokeStyle =
            "rgba(39, 107, 184, 0.55)";

        context.fillRect(
            node.x - 32,
            node.y - 16,
            64,
            32
        );

        context.strokeRect(
            node.x - 32,
            node.y - 16,
            64,
            32
        );

        context.fillStyle =
            "rgba(126, 174, 221, 0.75)";

        context.font =
            "8px Arial";

        context.textAlign =
            "center";

        context.textBaseline =
            "middle";

        context.fillText(
            node.label,
            node.x,
            node.y
        );
    }
}

function resizeWorld() {
    drawWorld();

    positionCompanion();
}

function drawPixel(
    context,
    x,
    y,
    scale,
    color
) {
    context.fillStyle = color;

    context.fillRect(
        Math.round(x * scale),
        Math.round(y * scale),
        Math.ceil(scale),
        Math.ceil(scale)
    );
}

function drawCompanion() {
    const canvas =
        elements.companionCanvas;

    if (!canvas) {
        return;
    }

    const context =
        canvas.getContext("2d");

    const size = 32;
    const scale = 4;

    canvas.width =
        size * scale;

    canvas.height =
        size * scale;

    context.clearRect(
        0,
        0,
        canvas.width,
        canvas.height
    );

    context.imageSmoothingEnabled =
        false;

    const bob =
        companion.moving
            ? Math.sin(companion.frame * 0.7) * 0.7
            : 0;

    const ox = 0;
    const oy = bob;

    const robe = "#101318";
    const robeDark = "#080a0d";
    const skin = "#d7aa82";
    const skinDark = "#9a7057";
    const eye = "#f4d447";
    const eyeGlow = "rgba(244, 212, 71, 0.25)";

    context.fillStyle =
        eyeGlow;

    context.fillRect(
        10 * scale,
        8 * scale,
        12 * scale,
        7 * scale
    );

    drawPixel(
        context,
        10 + ox,
        7 + oy,
        scale,
        robeDark
    );

    drawPixel(
        context,
        11 + ox,
        6 + oy,
        scale,
        robeDark
    );

    drawPixel(
        context,
        12 + ox,
        5 + oy,
        scale,
        robeDark
    );

    drawPixel(
        context,
        13 + ox,
        5 + oy,
        scale,
        robeDark
    );

    drawPixel(
        context,
        14 + ox,
        4 + oy,
        scale,
        robeDark
    );

    drawPixel(
        context,
        15 + ox,
        4 + oy,
        scale,
        robeDark
    );

    drawPixel(
        context,
        16 + ox,
        4 + oy,
        scale,
        robeDark
    );

    drawPixel(
        context,
        17 + ox,
        5 + oy,
        scale,
        robeDark
    );

    drawPixel(
        context,
        18 + ox,
        5 + oy,
        scale,
        robeDark
    );

    drawPixel(
        context,
        19 + ox,
        6 + oy,
        scale,
        robeDark
    );

    drawPixel(
        context,
        20 + ox,
        7 + oy,
        scale,
        robeDark
    );

    drawPixel(
        context,
        11 + ox,
        8 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        12 + ox,
        8 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        13 + ox,
        8 + oy,
        scale,
        skin
    );

    drawPixel(
        context,
        14 + ox,
        8 + oy,
        scale,
        skin
    );

    drawPixel(
        context,
        15 + ox,
        8 + oy,
        scale,
        skin
    );

    drawPixel(
        context,
        16 + ox,
        8 + oy,
        scale,
        skin
    );

    drawPixel(
        context,
        17 + ox,
        8 + oy,
        scale,
        skin
    );

    drawPixel(
        context,
        18 + ox,
        8 + oy,
        scale,
        skin
    );

    drawPixel(
        context,
        19 + ox,
        8 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        12 + ox,
        9 + oy,
        scale,
        skinDark
    );

    drawPixel(
        context,
        13 + ox,
        9 + oy,
        scale,
        skin
    );

    drawPixel(
        context,
        14 + ox,
        9 + oy,
        scale,
        eye
    );

    drawPixel(
        context,
        17 + ox,
        9 + oy,
        scale,
        eye
    );

    drawPixel(
        context,
        18 + ox,
        9 + oy,
        scale,
        skinDark
    );

    drawPixel(
        context,
        10 + ox,
        10 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        11 + ox,
        10 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        12 + ox,
        10 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        13 + ox,
        10 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        14 + ox,
        10 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        15 + ox,
        10 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        16 + ox,
        10 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        17 + ox,
        10 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        18 + ox,
        10 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        19 + ox,
        10 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        20 + ox,
        10 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        9 + ox,
        11 + oy,
        scale,
        robeDark
    );

    drawPixel(
        context,
        10 + ox,
        11 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        11 + ox,
        11 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        12 + ox,
        11 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        13 + ox,
        11 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        14 + ox,
        11 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        15 + ox,
        11 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        16 + ox,
        11 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        17 + ox,
        11 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        18 + ox,
        11 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        19 + ox,
        11 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        20 + ox,
        11 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        21 + ox,
        11 + oy,
        scale,
        robeDark
    );

    drawPixel(
        context,
        9 + ox,
        12 + oy,
        scale,
        robeDark
    );

    drawPixel(
        context,
        10 + ox,
        12 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        11 + ox,
        12 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        12 + ox,
        12 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        13 + ox,
        12 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        14 + ox,
        12 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        15 + ox,
        12 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        16 + ox,
        12 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        17 + ox,
        12 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        18 + ox,
        12 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        19 + ox,
        12 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        20 + ox,
        12 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        21 + ox,
        12 + oy,
        scale,
        robeDark
    );

    drawPixel(
        context,
        10 + ox,
        13 + oy,
        scale,
        robeDark
    );

    drawPixel(
        context,
        11 + ox,
        13 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        12 + ox,
        13 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        13 + ox,
        13 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        14 + ox,
        13 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        15 + ox,
        13 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        16 + ox,
        13 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        17 + ox,
        13 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        18 + ox,
        13 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        19 + ox,
        13 + oy,
        scale,
        robe
    );

    drawPixel(
        context,
        20 + ox,
        13 + oy,
        scale,
        robeDark
    );

    drawPixel(
        context,
        11 + ox,
        14 + oy,
        scale,
        robeDark
    );

    drawPixel(
        context,
        12 + ox,
        14 + oy,
        scale,
        robeDark
    );

    drawPixel(
        context,
        13 + ox,
        14 + oy,
        scale,
        robeDark
    );

    drawPixel(
        context,
        14 + ox,
        14 + oy,
        scale,
        robeDark
    );

    drawPixel(
        context,
        15 + ox,
        14 + oy,
        scale,
        robeDark
    );

    drawPixel(
        context,
        16 + ox,
        14 + oy,
        scale,
        robeDark
    );

    drawPixel(
        context,
        17 + ox,
        14 + oy,
        scale,
        robeDark
    );

    drawPixel(
        context,
        18 + ox,
        14 + oy,
        scale,
        robeDark
    );

    drawPixel(
        context,
        19 + ox,
        14 + oy,
        scale,
        robeDark
    );

    drawPixel(
        context,
        12 + ox,
        15 + oy,
        scale,
        robeDark
    );

    drawPixel(
        context,
        13 + ox,
        15 + oy,
        scale,
        robeDark
    );

    drawPixel(
        context,
        14 + ox,
        15 + oy,
        scale,
        robeDark
    );

    drawPixel(
        context,
        17 + ox,
        15 + oy,
        scale,
        robeDark
    );

    drawPixel(
        context,
        18 + ox,
        15 + oy,
        scale,
        robeDark
    );

    drawPixel(
        context,
        19 + ox,
        15 + oy,
        scale,
        robeDark
    );

    if (companion.direction === "left") {
        drawPixel(
            context,
            12 + ox,
            9 + oy,
            scale,
            eye
        );
    }

    if (companion.direction === "right") {
        drawPixel(
            context,
            18 + ox,
            9 + oy,
            scale,
            eye
        );
    }
}

function positionCompanion() {
    if (
        !elements.companionCanvas ||
        !elements.worldStage
    ) {
        return;
    }

    const width =
        elements.worldStage.clientWidth;

    const height =
        elements.worldStage.clientHeight;

    const marginX = 90;
    const marginY = 100;

    companion.x =
        Math.max(
            marginX,
            Math.min(
                width - marginX,
                companion.x || width / 2
            )
        );

    companion.y =
        Math.max(
            marginY,
            Math.min(
                height - marginY,
                companion.y || height / 2
            )
        );

    elements.companionCanvas.style.left =
        `${companion.x}px`;

    elements.companionCanvas.style.top =
        `${companion.y}px`;

    elements.companionShadow.style.left =
        `${companion.x}px`;

    elements.companionShadow.style.top =
        `${companion.y + 28}px`;
}

function chooseCompanionTarget() {
    const width =
        elements.worldStage.clientWidth;

    const height =
        elements.worldStage.clientHeight;

    const marginX = 110;
    const marginY = 120;

    companion.targetX =
        marginX +
        Math.random() *
        Math.max(
            1,
            width - marginX * 2
        );

    companion.targetY =
        marginY +
        Math.random() *
        Math.max(
            1,
            height - marginY * 2
        );

    companion.moving = true;

    const dx =
        companion.targetX -
        companion.x;

    const dy =
        companion.targetY -
        companion.y;

    if (
        Math.abs(dx) >
        Math.abs(dy)
    ) {
        companion.direction =
            dx > 0
                ? "right"
                : "left";
    } else {
        companion.direction =
            dy > 0
                ? "down"
                : "up";
    }
}

function updateCompanion(delta) {
    companion.idleTimer -= delta;

    if (
        !companion.moving &&
        companion.idleTimer <= 0
    ) {
        chooseCompanionTarget();
    }

    if (!companion.moving) {
        return;
    }

    const dx =
        companion.targetX -
        companion.x;

    const dy =
        companion.targetY -
        companion.y;

    const distance =
        Math.sqrt(
            dx * dx +
            dy * dy
        );

    if (distance < 2) {
        companion.x =
            companion.targetX;

        companion.y =
            companion.targetY;

        companion.moving = false;
        companion.idleTimer =
            700 +
            Math.random() * 1800;

        companion.frame = 0;

        elements.companionStatus.textContent =
            "Idle";

        elements.runtimeCompanion.textContent =
            "Idle";

        elements.systemCompanion.textContent =
            "Idle";

        return;
    }

    const step =
        companion.speed *
        delta;

    companion.x +=
        (dx / distance) *
        step;

    companion.y +=
        (dy / distance) *
        step;

    companion.frame +=
        delta * 0.012;

    elements.companionStatus.textContent =
        "Moving";

    elements.runtimeCompanion.textContent =
        `Moving ${companion.direction}`;

    elements.systemCompanion.textContent =
        `Moving ${companion.direction}`;

    positionCompanion();
}

function moveCompanion(direction) {
    const amount = 30;

    companion.direction =
        direction;

    companion.moving = true;

    companion.idleTimer = 0;

    if (direction === "up") {
        companion.targetY -= amount;
    }

    if (direction === "down") {
        companion.targetY += amount;
    }

    if (direction === "left") {
        companion.targetX -= amount;
    }

    if (direction === "right") {
        companion.targetX += amount;
    }

    const width =
        elements.worldStage.clientWidth;

    const height =
        elements.worldStage.clientHeight;

    companion.targetX =
        Math.max(
            90,
            Math.min(
                width - 90,
                companion.targetX
            )
        );

    companion.targetY =
        Math.max(
            100,
            Math.min(
                height - 100,
                companion.targetY
            )
        );
}

function companionReactToAnalysis(result) {
    if (!result) {
        return;
    }

    if (!result.success) {
        companion.direction =
            "left";

        moveCompanion("left");

        return;
    }

    const issues =
        result.typos.length +
        result.undeclared.length +
        result.unused.length;

    if (issues > 0) {
        moveCompanion("up");
    } else {
        moveCompanion("right");
    }

    Nexus.emit(
        "companion:reaction",
        {
            issues
        }
    );
}

let previousTime =
    performance.now();

function companionLoop(time) {
    const delta =
        Math.min(
            50,
            time - previousTime
        );

    previousTime = time;

    updateCompanion(delta);
    drawCompanion();

    requestAnimationFrame(
        companionLoop
    );
}

function initializeCompanion() {
    const width =
        elements.worldStage.clientWidth;

    const height =
        elements.worldStage.clientHeight;

    companion.x =
        width / 2;

    companion.y =
        height / 2;

    companion.targetX =
        companion.x;

    companion.targetY =
        companion.y;

    companion.idleTimer =
        1200;

    positionCompanion();
    drawCompanion();
}

function setupKeyboard() {
    document.addEventListener(
        "keydown",
        event => {
            const tag =
                document.activeElement?.tagName;

            if (
                tag === "TEXTAREA" ||
                tag === "INPUT"
            ) {
                return;
            }

            const keys = {
                ArrowUp: "up",
                w: "up",
                W: "up",
                ArrowDown: "down",
                s: "down",
                S: "down",
                ArrowLeft: "left",
                a: "left",
                A: "left",
                ArrowRight: "right",
                d: "right",
                D: "right"
            };

            const direction =
                keys[event.key];

            if (!direction) {
                return;
            }

            event.preventDefault();

            moveCompanion(
                direction
            );
        }
    );
}

function setupNexus() {
    Nexus.on(
        "analysis:start",
        () => {
            addEvent(
                "Analysis pipeline started."
            );
        }
    );

    Nexus.on(
        "analysis:complete",
        data => {
            addEvent(
                `Analysis completed. ${data.issues} issue(s).`
            );
        }
    );

    Nexus.on(
        "analysis:error",
        data => {
            addEvent(
                `Parser error: ${data.message}`
            );
        }
    );

    Nexus.on(
        "analysis:clear",
        () => {
            addEvent(
                "Analysis state cleared."
            );
        }
    );

    Nexus.on(
        "view:change",
        data => {
            addEvent(
                `Workspace changed to ${data.view}.`
            );
        }
    );

    Nexus.on(
        "companion:reaction",
        data => {
            addEvent(
                `Companion reacted to ${data.issues} issue(s).`
            );
        }
    );
}

function setupButtons() {
    elements.analyzeButton.addEventListener(
        "click",
        analyze
    );

    elements.clearButton.addEventListener(
        "click",
        clearAnalysis
    );
}

function initializeSystem() {
    elements.systemNjos.textContent =
        `Online v${NJOS.version}`;

    elements.systemNexus.textContent =
        "Connected";

    elements.systemParser.textContent =
        "Acorn";

    elements.runtimeNexus.textContent =
        "Connected";

    elements.runtimeParser.textContent =
        "Acorn";

    elements.nexusStreamStatus.textContent =
        "live";

    setSystemState(
        "SYSTEM READY"
    );

    setMessage(
        "Cakrawala ready"
    );

    addEvent(
        `NJOS ${NJOS.version} initialized.`
    );

    addEvent(
        "Cakrawala Nexus connected."
    );

    addEvent(
        "World workspace initialized."
    );

    Nexus.emit(
        "system:ready",
        {
            njos: NJOS.version
        }
    );
}

function initialize() {
    setupTabs();
    setupButtons();
    setupKeyboard();
    setupNexus();
    initializeSystem();

    resizeWorld();
    initializeCompanion();

    window.addEventListener(
        "resize",
        resizeWorld
    );

    requestAnimationFrame(
        companionLoop
    );
}

initialize();
