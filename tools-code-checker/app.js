const NJOS = {
    version: "0.6.0",
    globals: new Set([
        "console",
        "Math",
        "Date",
        "JSON",
        "Array",
        "Object",
        "String",
        "Number",
        "Boolean",
        "Set",
        "Map",
        "Promise",
        "RegExp",
        "Error",
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
        const record = {
            event,
            data,
            time: new Date().toLocaleTimeString()
        };

        this.history.push(record);

        const callbacks = this.listeners.get(event) || [];

        callbacks.forEach(callback => {
            try {
                callback(data);
            } catch (error) {
                console.error(error);
            }
        });
    }
}

const nexus = new CakrawalaNexus();

class SymbolRecord {
    constructor(name, type, node, scope) {
        this.name = name;
        this.type = type;
        this.node = node;
        this.scope = scope;
        this.references = [];
        this.declarationLine = node?.loc?.start?.line || 0;
    }
}

class Scope {
    constructor(parent = null, type = "block") {
        this.parent = parent;
        this.type = type;
        this.symbols = new Map();
        this.children = [];
    }

    declare(name, type, node) {
        if (!name) return null;

        if (this.symbols.has(name)) {
            return this.symbols.get(name);
        }

        const symbol = new SymbolRecord(
            name,
            type,
            node,
            this
        );

        this.symbols.set(name, symbol);

        return symbol;
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

        while (scope && scope.type !== "function" && scope.parent) {
            scope = scope.parent;
        }

        return scope;
    }
}

class ScopeResolver {
    constructor(ast) {
        this.ast = ast;
        this.root = new Scope(null, "program");
        this.current = this.root;
        this.references = [];
        this.declarations = [];
    }

    addBuiltins() {
        NJOS.globals.forEach(name => {
            this.root.declare(
                name,
                "builtin",
                {
                    loc: {
                        start: {
                            line: 0
                        }
                    }
                }
            );
        });
    }

    child(type = "block") {
        const scope = new Scope(this.current, type);

        this.current.children.push(scope);

        return scope;
    }

    withScope(scope, callback) {
        const previous = this.current;

        this.current = scope;

        try {
            callback();
        } finally {
            this.current = previous;
        }
    }

    declarePattern(pattern, type = "variable") {
        if (!pattern) return;

        if (pattern.type === "Identifier") {
            const symbol = this.current.declare(
                pattern.name,
                type,
                pattern
            );

            if (symbol) {
                this.declarations.push(symbol);
            }

            return;
        }

        if (
            pattern.type === "ObjectPattern" ||
            pattern.type === "ArrayPattern"
        ) {
            pattern.properties?.forEach(property => {
                if (!property) return;

                if (property.type === "RestElement") {
                    this.declarePattern(property.argument, type);
                    return;
                }

                if (property.type === "Property") {
                    this.declarePattern(property.value, type);
                }
            });

            return;
        }

        if (pattern.type === "AssignmentPattern") {
            this.declarePattern(pattern.left, type);
            return;
        }

        if (pattern.type === "RestElement") {
            this.declarePattern(pattern.argument, type);
        }
    }

    reference(identifier) {
        if (!identifier || identifier.type !== "Identifier") {
            return;
        }

        const name = identifier.name;

        if (NJOS.globals.has(name)) {
            return;
        }

        this.references.push({
            name,
            node: identifier,
            scope: this.current
        });
    }

    visitFunction(node) {
        const functionScope = this.child("function");

        this.withScope(functionScope, () => {
            if (node.id) {
                this.current.declare(
                    node.id.name,
                    "function",
                    node.id
                );
            }

            node.params?.forEach(param => {
                this.declarePattern(
                    param,
                    "parameter"
                );
            });

            this.visit(node.body);
        });
    }

    visit(node) {
        if (!node) return;

        switch (node.type) {
            case "Program":
                node.body.forEach(statement => this.visit(statement));
                break;

            case "VariableDeclaration":
                node.declarations.forEach(declaration => {
                    this.declarePattern(
                        declaration.id,
                        "variable"
                    );

                    if (declaration.init) {
                        this.expression(declaration.init);
                    }
                });
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
                const blockScope = this.child("block");

                this.withScope(blockScope, () => {
                    node.body.forEach(statement => {
                        this.visit(statement);
                    });
                });

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

            case "WhileStatement":
            case "DoWhileStatement":
                this.expression(node.test);
                this.visit(node.body);
                break;

            case "ForStatement":
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
                break;

            case "ForInStatement":
            case "ForOfStatement":
                if (
                    node.left?.type ===
                    "VariableDeclaration"
                ) {
                    this.visit(node.left);
                } else {
                    this.expression(node.left);
                }

                this.expression(node.right);
                this.visit(node.body);
                break;

            case "ThrowStatement":
                this.expression(node.argument);
                break;

            case "TryStatement":
                this.visit(node.block);

                if (node.handler) {
                    const catchScope = this.child("block");

                    this.withScope(catchScope, () => {
                        if (node.handler.param) {
                            this.declarePattern(
                                node.handler.param,
                                "catch"
                            );
                        }

                        this.visit(node.handler.body);
                    });
                }

                if (node.finalizer) {
                    this.visit(node.finalizer);
                }

                break;

            case "SwitchStatement":
                this.expression(node.discriminant);

                node.cases.forEach(item => {
                    if (item.test) {
                        this.expression(item.test);
                    }

                    item.consequent.forEach(statement => {
                        this.visit(statement);
                    });
                });

                break;

            default:
                this.generic(node);
        }
    }

    expression(node) {
        if (!node) return;

        switch (node.type) {
            case "Identifier":
                this.reference(node);
                break;

            case "Literal":
                break;

            case "MemberExpression":
                this.expression(node.object);

                if (node.computed) {
                    this.expression(node.property);
                }

                break;

            case "CallExpression":
                this.expression(node.callee);

                node.arguments?.forEach(argument => {
                    this.expression(argument);
                });

                break;

            case "NewExpression":
                this.expression(node.callee);

                node.arguments?.forEach(argument => {
                    this.expression(argument);
                });

                break;

            case "BinaryExpression":
            case "LogicalExpression":
            case "AssignmentExpression":
                this.expression(node.left);
                this.expression(node.right);
                break;

            case "UnaryExpression":
            case "UpdateExpression":
                this.expression(node.argument);
                break;

            case "ConditionalExpression":
                this.expression(node.test);
                this.expression(node.consequent);
                this.expression(node.alternate);
                break;

            case "ArrayExpression":
                node.elements?.forEach(element => {
                    this.expression(element);
                });
                break;

            case "ObjectExpression":
                node.properties?.forEach(property => {
                    if (!property) return;

                    if (property.type === "SpreadElement") {
                        this.expression(property.argument);
                        return;
                    }

                    if (property.computed) {
                        this.expression(property.key);
                    }

                    this.expression(property.value);
                });
                break;

            case "AssignmentPattern":
                this.expression(node.right);
                break;

            case "ArrowFunctionExpression":
            case "FunctionExpression":
                this.visitFunction(node);
                break;

            case "TemplateLiteral":
                node.expressions?.forEach(expression => {
                    this.expression(expression);
                });
                break;

            case "SequenceExpression":
                node.expressions?.forEach(expression => {
                    this.expression(expression);
                });
                break;

            case "AwaitExpression":
            case "YieldExpression":
                this.expression(node.argument);
                break;

            default:
                this.generic(node);
        }
    }

    generic(node) {
        if (!node || typeof node !== "object") {
            return;
        }

        Object.keys(node).forEach(key => {
            if (
                key === "loc" ||
                key === "start" ||
                key === "end"
            ) {
                return;
            }

            const value = node[key];

            if (!value) return;

            if (Array.isArray(value)) {
                value.forEach(item => {
                    if (
                        item &&
                        typeof item.type === "string"
                    ) {
                        if (
                            item.type.endsWith(
                                "Expression"
                            )
                        ) {
                            this.expression(item);
                        } else {
                            this.visit(item);
                        }
                    }
                });
            } else if (
                value &&
                typeof value.type === "string"
            ) {
                if (
                    value.type.endsWith(
                        "Expression"
                    )
                ) {
                    this.expression(value);
                } else {
                    this.visit(value);
                }
            }
        });
    }

    resolve() {
        this.addBuiltins();
        this.visit(this.ast);

        return {
            root: this.root,
            references: this.references,
            declarations: this.declarations
        };
    }
}

class TypoDetector {
    static distance(a, b) {
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
                    matrix[i][j] =
                        Math.min(
                            matrix[i - 1][j - 1] + 1,
                            matrix[i][j - 1] + 1,
                            matrix[i - 1][j] + 1
                        );
                }
            }
        }

        return matrix[b.length][a.length];
    }

    static similarity(a, b) {
        if (!a || !b) return 0;

        const max = Math.max(
            a.length,
            b.length
        );

        if (!max) return 1;

        return 1 - this.distance(a, b) / max;
    }

    static detect(name, candidates) {
        let best = null;
        let bestScore = 0;

        candidates.forEach(candidate => {
            const score = this.similarity(
                name,
                candidate
            );

            if (score > bestScore) {
                bestScore = score;
                best = candidate;
            }
        });

        if (best && bestScore >= 0.72) {
            return {
                name,
                suggestion: best,
                confidence: Math.round(
                    bestScore * 100
                )
            };
        }

        return null;
    }
}

class Analyzer {
    unused(result) {
        const issues = [];

        result.declarations.forEach(symbol => {
            if (
                symbol.type === "builtin" ||
                symbol.references.length > 0
            ) {
                return;
            }

            issues.push({
                type: "unused",
                name: symbol.name,
                line: symbol.declarationLine,
                message:
                    `"${symbol.name}" is declared but never used.`
            });
        });

        return issues;
    }

    undeclared(result) {
        const issues = [];

        result.references.forEach(reference => {
            const resolved =
                reference.scope.resolve(
                    reference.name
                );

            if (resolved) {
                resolved.references.push(
                    reference
                );
                return;
            }

            issues.push({
                type: "undeclared",
                name: reference.name,
                line:
                    reference.node?.loc?.start?.line ||
                    0,
                message:
                    `"${reference.name}" is not declared.`
            });
        });

        return issues;
    }
}

class CodeChecker {
    constructor() {
        this.analyzer = new Analyzer();
    }

    parse(code) {
        return acorn.parse(code, {
            ecmaVersion: "latest",
            sourceType: "script",
            locations: true
        });
    }

    run(code) {
        let ast;

        try {
            ast = this.parse(code);
        } catch (error) {
            return {
                ok: false,
                syntaxError: {
                    message: error.message,
                    line: error.loc?.line || 0,
                    column:
                        error.loc?.column || 0
                },
                issues: [],
                symbols: [],
                scopes: 0
            };
        }

        const resolver =
            new ScopeResolver(ast);

        const resolved =
            resolver.resolve();

        const typoIssues = [];
        const undeclaredIssues =
            this.analyzer.undeclared(resolved);

        const knownNames =
            resolved.declarations
                .filter(
                    symbol =>
                        symbol.type !== "builtin"
                )
                .map(
                    symbol => symbol.name
                );

        undeclaredIssues.forEach(issue => {
            const typo =
                TypoDetector.detect(
                    issue.name,
                    knownNames
                );

            if (typo) {
                typoIssues.push({
                    type: "typo",
                    name: issue.name,
                    suggestion:
                        typo.suggestion,
                    confidence:
                        typo.confidence,
                    line: issue.line,
                    message:
                        `Possible typo: "${issue.name}" may be "${typo.suggestion}".`
                });
            }
        });

        const typoNames =
            new Set(
                typoIssues.map(
                    issue => issue.name
                )
            );

        const filteredUndeclared =
            undeclaredIssues.filter(
                issue =>
                    !typoNames.has(
                        issue.name
                    )
            );

        const unusedIssues =
            this.analyzer.unused(
                resolved
            );

        return {
            ok: true,
            syntaxError: null,
            issues: [
                ...typoIssues,
                ...filteredUndeclared,
                ...unusedIssues
            ],
            symbols:
                resolved.declarations.filter(
                    symbol =>
                        symbol.type !== "builtin"
                ),
            scopes:
                this.countScopes(
                    resolved.root
                )
        };
    }

    countScopes(scope) {
        let count = 1;

        scope.children.forEach(child => {
            count += this.countScopes(child);
        });

        return count;
    }
}

const checker = new CodeChecker();

const codeEditor =
    document.getElementById(
        "codeEditor"
    );

const analysisOutput =
    document.getElementById(
        "analysisOutput"
    );

const variableContent =
    document.getElementById(
        "variableContent"
    );

const eventList =
    document.getElementById(
        "eventList"
    );

const workspaceTitle =
    document.getElementById(
        "workspaceTitle"
    );

const nexusMessage =
    document.getElementById(
        "nexusMessage"
    );

const nexusStatus =
    document.getElementById(
        "nexusStatus"
    );

const systemState =
    document.getElementById(
        "systemState"
    );

const systemBox =
    document.getElementById(
        "systemBox"
    );

const companionStatus =
    document.getElementById(
        "companionStatus"
    );

const runtimeCompanion =
    document.getElementById(
        "runtimeCompanion"
    );

const runtimeNexus =
    document.getElementById(
        "runtimeNexus"
    );

const worldView =
    document.getElementById(
        "worldView"
    );

const companionCanvas =
    document.getElementById(
        "companionCanvas"
    );

const companionShadow =
    document.getElementById(
        "companionShadow"
    );

const companionContext =
    companionCanvas?.getContext(
        "2d"
    );

const companion = {
    x: 60,
    y: 60,
    direction: "down",
    frame: 0,
    timer: 0,
    moving: false,
    wait: 0,
    targetX: 60,
    targetY: 60,
    speed: 0.7
};

function setMessage(message) {
    if (nexusMessage) {
        nexusMessage.textContent =
            message;
    }
}

function addEvent(message) {
    if (!eventList) return;

    const item =
        document.createElement(
            "div"
        );

    item.className = "event-item";

    item.textContent =
        `[${new Date().toLocaleTimeString()}] ${message}`;

    eventList.prepend(item);

    while (
        eventList.children.length > 30
    ) {
        eventList.lastChild.remove();
    }
}

function drawPixel(
    ctx,
    x,
    y,
    size,
    color
) {
    ctx.fillStyle = color;
    ctx.fillRect(
        Math.round(x),
        Math.round(y),
        size,
        size
    );
}

function drawCompanion() {
    if (!companionContext) return;

    const canvas =
        companionCanvas;

    companionContext.clearRect(
        0,
        0,
        canvas.width,
        canvas.height
    );

    const ctx =
        companionContext;

    const scale = 4;

    const px =
        Math.round(
            companion.x
        );

    const py =
        Math.round(
            companion.y
        );

    ctx.imageSmoothingEnabled =
        false;

    ctx.save();

    ctx.translate(
        px,
        py
    );

    if (
        companion.direction ===
        "left"
    ) {
        ctx.scale(-1, 1);
    }

    const bob =
        companion.moving
            ? companion.frame === 0
                ? 0
                : 1
            : 0;

    drawPixel(
        ctx,
        -3 * scale,
        7 * scale + bob,
        6 * scale,
        "#090b12"
    );

    drawPixel(
        ctx,
        -4 * scale,
        9 * scale + bob,
        8 * scale,
        "#090b12"
    );

    drawPixel(
        ctx,
        -5 * scale,
        11 * scale + bob,
        10 * scale,
        "#090b12"
    );

    drawPixel(
        ctx,
        -4 * scale,
        13 * scale + bob,
        8 * scale,
        "#111621"
    );

    drawPixel(
        ctx,
        -3 * scale,
        4 * scale + bob,
        6 * scale,
        "#c9a07b"
    );

    drawPixel(
        ctx,
        -4 * scale,
        2 * scale + bob,
        8 * scale,
        "#05070b"
    );

    drawPixel(
        ctx,
        -3 * scale,
        1 * scale + bob,
        6 * scale,
        "#05070b"
    );

    drawPixel(
        ctx,
        -2 * scale,
        5 * scale + bob,
        1 * scale,
        "#f3d84b"
    );

    drawPixel(
        ctx,
        1 * scale,
        5 * scale + bob,
        1 * scale,
        "#f3d84b"
    );

    if (
        companion.direction ===
        "up"
    ) {
        drawPixel(
            ctx,
            -3 * scale,
            3 * scale + bob,
            6 * scale,
            "#05070b"
        );
    }

    drawPixel(
        ctx,
        -4 * scale,
        15 * scale + bob,
        3 * scale,
        "#07090e"
    );

    drawPixel(
        ctx,
        1 * scale,
        15 * scale + bob,
        3 * scale,
        "#07090e"
    );

    ctx.restore();

    if (companionShadow) {
        companionShadow.style.left =
            `${px - 16}px`;

        companionShadow.style.top =
            `${py + 54}px`;
    }
}

function randomDirection() {
    const directions = [
        "up",
        "down",
        "left",
        "right"
    ];

    return directions[
        Math.floor(
            Math.random() *
                directions.length
        )
    ];
}

function updateCompanion() {
    if (!worldView) return;

    if (
        companion.wait > 0
    ) {
        companion.wait--;

        companion.moving = false;

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

    if (
        distance < 2
    ) {
        companion.moving = false;

        companion.wait =
            40 +
            Math.floor(
                Math.random() *
                    100
            );

        const padding = 35;

        companion.targetX =
            padding +
            Math.random() *
                Math.max(
                    20,
                    worldView.clientWidth -
                        padding * 2
                );

        companion.targetY =
            padding +
            Math.random() *
                Math.max(
                    20,
                    worldView.clientHeight -
                        padding * 2
                );

        const direction =
            randomDirection();

        companion.direction =
            direction;

        return;
    }

    companion.moving = true;

    const vx =
        dx / distance;

    const vy =
        dy / distance;

    companion.x +=
        vx *
        companion.speed;

    companion.y +=
        vy *
        companion.speed;

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

    companion.timer++;

    if (
        companion.timer >= 12
    ) {
        companion.timer = 0;

        companion.frame =
            companion.frame ===
            0
                ? 1
                : 0;
    }
}

function companionLoop() {
    updateCompanion();
    drawCompanion();

    requestAnimationFrame(
        companionLoop
    );
}

function moveCompanionTo(
    x,
    y
) {
    companion.targetX = x;
    companion.targetY = y;
    companion.wait = 0;
}

function formatIssue(issue) {
    if (
        issue.type ===
        "typo"
    ) {
        return `
            <div class="issue warning">
                <strong>Possible typo</strong>
                <span>Line ${issue.line}</span>
                <p>
                    "${issue.name}" →
                    "${issue.suggestion}"
                    (${issue.confidence}% confidence)
                </p>
            </div>
        `;
    }

    if (
        issue.type ===
        "undeclared"
    ) {
        return `
            <div class="issue error">
                <strong>Undeclared variable</strong>
                <span>Line ${issue.line}</span>
                <p>${issue.message}</p>
            </div>
        `;
    }

    if (
        issue.type ===
        "unused"
    ) {
        return `
            <div class="issue info">
                <strong>Unused variable</strong>
                <span>Line ${issue.line}</span>
                <p>${issue.message}</p>
            </div>
        `;
    }

    return "";
}

function renderAnalysis(result) {
    if (!analysisOutput) return;

    if (!result.ok) {
        analysisOutput.innerHTML = `
            <div class="issue error">
                <strong>Syntax Error</strong>
                <span>Line ${result.syntaxError.line}</span>
                <p>${result.syntaxError.message}</p>
            </div>
        `;

        return;
    }

    if (
        result.issues.length ===
        0
    ) {
        analysisOutput.innerHTML = `
            <div class="analysis-success">
                <strong>Analysis complete</strong>
                <span>No issues detected.</span>
            </div>
        `;

        return;
    }

    analysisOutput.innerHTML =
        result.issues
            .map(formatIssue)
            .join("");
}

function renderVariables(
    result
) {
    if (!variableContent) return;

    if (
        !result ||
        !result.symbols ||
        result.symbols.length ===
            0
    ) {
        variableContent.innerHTML = `
            <div class="empty-state">
                No symbols detected.
            </div>
        `;

        return;
    }

    variableContent.innerHTML =
        result.symbols
            .map(symbol => `
                <div class="variable-row">
                    <strong>${symbol.name}</strong>
                    <span>${symbol.type}</span>
                    <small>
                        line ${symbol.declarationLine}
                    </small>
                </div>
            `)
            .join("");
}

let lastResult = null;

function analyze() {
    if (!codeEditor) return;

    const code =
        codeEditor.value;

    setMessage(
        "Nexus is analyzing the workspace..."
    );

    if (nexusStatus) {
        nexusStatus.textContent =
            "ANALYZING";
    }

    if (systemState) {
        systemState.textContent =
            "ANALYZING";
    }

    nexus.emit(
        "analysis:start",
        {
            codeLength:
                code.length
        }
    );

    addEvent(
        "Analysis started"
    );

    const result =
        checker.run(code);

    lastResult =
        result;

    renderAnalysis(
        result
    );

    renderVariables(
        result
    );

    if (result.ok) {
        setMessage(
            result.issues.length
                ? `${result.issues.length} issue(s) detected.`
                : "Analysis complete. Workspace is clean."
        );
    } else {
        setMessage(
            "Syntax error detected."
        );
    }

    if (nexusStatus) {
        nexusStatus.textContent =
            "ONLINE";
    }

    if (systemState) {
        systemState.textContent =
            result.ok
                ? "READY"
                : "ERROR";
    }

    if (runtimeNexus) {
        runtimeNexus.textContent =
            "Connected";
    }

    if (runtimeCompanion) {
        runtimeCompanion.textContent =
            "Active";
    }

    if (companionStatus) {
        companionStatus.textContent =
            result.ok
                ? "Observing"
                : "Alert";
    }

    addEvent(
        result.ok
            ? "Analysis completed"
            : "Analysis failed"
    );

    nexus.emit(
        "analysis:complete",
        result
    );

    moveCompanionTo(
        Math.random() *
            Math.max(
                50,
                worldView?.clientWidth ||
                    100
            ),
        Math.random() *
            Math.max(
                50,
                worldView?.clientHeight ||
                    100
            )
    );
}

const toolNames = {
    editor: "Code Editor",
    analyzer: "Analyzer",
    variables:
        "Variable Manager",
    runtime:
        "Runtime Monitor",
    nexus: "Nexus"
};

document
    .querySelectorAll(".tool")
    .forEach(tool => {
        tool.addEventListener(
            "click",
            () => {
                const target =
                    tool.dataset.tool;

                document
                    .querySelectorAll(
                        ".tool"
                    )
                    .forEach(item => {
                        item.classList.remove(
                            "active"
                        );
                    });

                tool.classList.add(
                    "active"
                );

                document
                    .querySelectorAll(
                        ".view"
                    )
                    .forEach(view => {
                        view.classList.remove(
                            "active"
                        );
                    });

                const view =
                    document.getElementById(
                        `${target}View`
                    );

                if (view) {
                    view.classList.add(
                        "active"
                    );
                }

                if (workspaceTitle) {
                    workspaceTitle.textContent =
                        toolNames[
                            target
                        ] ||
                        "Workspace";
                }

                addEvent(
                    `Opened ${toolNames[target] || target}`
                );
            }
        );
    });

const analyzeButton =
    document.getElementById(
        "analyzeButton"
    );

if (analyzeButton) {
    analyzeButton.addEventListener(
        "click",
        analyze
    );
}

const clearButton =
    document.getElementById(
        "clearButton"
    );

if (clearButton) {
    clearButton.addEventListener(
        "click",
        () => {
            if (codeEditor) {
                codeEditor.value = "";
            }

            if (analysisOutput) {
                analysisOutput.innerHTML = `
                    <div class="empty-state">
                        Analysis output will appear here.
                    </div>
                `;
            }

            if (variableContent) {
                variableContent.innerHTML = `
                    <div class="empty-state">
                        No symbols detected.
                    </div>
                `;
            }

            lastResult = null;

            setMessage(
                "Workspace cleared."
            );

            addEvent(
                "Workspace cleared"
            );

            if (systemState) {
                systemState.textContent =
                    "IDLE";
            }

            if (nexusStatus) {
                nexusStatus.textContent =
                    "ONLINE";
            }

            moveCompanionTo(
                Math.max(
                    50,
                    (worldView?.clientWidth ||
                        100) / 2
                ),
                Math.max(
                    50,
                    (worldView?.clientHeight ||
                        100) / 2
                )
            );
        }
    );
}

nexus.on(
    "analysis:start",
    () => {
        addEvent(
            "Nexus → Analyzer"
        );
    }
);

nexus.on(
    "analysis:complete",
    result => {
        addEvent(
            result.ok
                ? "Analyzer → Nexus: result received"
                : "Analyzer → Nexus: error received"
        );
    }
);

window.addEventListener(
    "keydown",
    event => {
        if (
            event.key === "ArrowUp" ||
            event.key === "w"
        ) {
            companion.direction =
                "up";
            companion.targetY -=
                40;
            companion.wait = 0;
        }

        if (
            event.key === "ArrowDown" ||
            event.key === "s"
        ) {
            companion.direction =
                "down";
            companion.targetY +=
                40;
            companion.wait = 0;
        }

        if (
            event.key === "ArrowLeft" ||
            event.key === "a"
        ) {
            companion.direction =
                "left";
            companion.targetX -=
                40;
            companion.wait = 0;
        }

        if (
            event.key === "ArrowRight" ||
            event.key === "d"
        ) {
            companion.direction =
                "right";
            companion.targetX +=
                40;
            companion.wait = 0;
        }
    }
);

window.addEventListener(
    "resize",
    () => {
        if (!worldView) return;

        companion.x =
            Math.min(
                companion.x,
                Math.max(
                    20,
                    worldView.clientWidth -
                        20
                )
            );

        companion.y =
            Math.min(
                companion.y,
                Math.max(
                    20,
                    worldView.clientHeight -
                        20
                )
            );
    }
);

if (worldView) {
    companion.x =
        worldView.clientWidth / 2;

    companion.y =
        worldView.clientHeight / 2;

    companion.targetX =
        companion.x;

    companion.targetY =
        companion.y;
}

if (codeEditor) {
    codeEditor.addEventListener(
        "input",
        () => {
            if (systemState) {
                systemState.textContent =
                    "MODIFIED";
            }
        }
    );
}

addEvent(
    "Cakrawala Workstation initialized"
);

addEvent(
    `NJOS ${NJOS.version} online`
);

setMessage(
    "Nexus connected. Workspace ready."
);

if (nexusStatus) {
    nexusStatus.textContent =
        "ONLINE";
}

if (systemState) {
    systemState.textContent =
        "IDLE";
}

if (companionStatus) {
    companionStatus.textContent =
        "Idle";
}

companionLoop();
