import assert = require("assert");
import { existsSync, readFileSync } from "fs";
import { dirname, resolve as resolvePath } from "path";
import * as Lint from "tslint";
import * as TsType from "typescript";

type Program = TsType.Program;
type SourceFile = TsType.SourceFile;

// Based on https://github.com/danvk/typings-checker

export class Rule extends Lint.Rules.TypedRule {
	/* tslint:disable:object-literal-sort-keys */
	static metadata: Lint.IRuleMetadata = {
		ruleName: "expect",
		description: "Asserts types with $ExpectType and presence of errors with $ExpectError.",
		optionsDescription: "Not configurable.",
		options: null,
		type: "functionality",
		typescriptOnly: true,
		requiresTypeInfo: true,
	};
	/* tslint:enable:object-literal-sort-keys */

	static FAILURE_STRING_DUPLICATE_ASSERTION = "This line has 2 $ExpectType assertions.";
	static FAILURE_STRING_ASSERTION_MISSING_NODE = "Can not match a node to this assertion.";
	static FAILURE_STRING_EXPECTED_ERROR = "Expected an error on this line, but found none.";

	static FAILURE_STRING(expectedType: string, actualType: string): string {
		return `Expected type to be:\n  ${expectedType}\ngot:\n  ${actualType}`;
	}

	applyWithProgram(sourceFile: SourceFile, lintProgram: Program): Lint.RuleFailure[] {
		const options = this.ruleArguments[0] as Options | undefined;
		if (!options) {
			return this.applyWithFunction(sourceFile, ctx =>
				walk(ctx, lintProgram, TsType, "next", /*nextHigherVersion*/ undefined));
		}

		const getFailures = (versionName: string, path: string, nextHigherVersion: string | undefined) => {
			const ts = require(path);
			const program = getProgram(options.tsconfigPath, ts, versionName, lintProgram);
			return this.applyWithFunction(sourceFile, ctx => walk(ctx, program, ts, versionName, nextHigherVersion));
		};

		const nextFailures = getFailures("next", options.tsNextPath, /*nextHigherVersion*/ undefined);
		if (nextFailures.length) {
			return nextFailures;
		}

		assert(options.olderInstalls.length);

		// As an optimization, check the earliest version for errors;
		// assume that if it works on min and next, it works for everything in between.
		const minInstall = options.olderInstalls[0];
		const minFailures = getFailures(minInstall.versionName, minInstall.path, undefined);
		if (!minFailures.length) {
			return [];
		}

		// There are no failures in `next`, but there are failures in `min`.
		// Work backward to find the newest version with failures.
		for (let i = options.olderInstalls.length - 1; i >= 0; i--) {
			const { versionName, path } = options.olderInstalls[i];
			console.log(`Test with ${versionName}`);
			const nextHigherVersion = i === options.olderInstalls.length - 1 ? "next" : options.olderInstalls[i + 1].versionName;
			const failures = getFailures(versionName, path, nextHigherVersion);
			if (failures.length) {
				return failures;
			}
		}

		throw new Error(); // unreachable -- at least the min version should have failures.
	}
}

export interface Options {
	readonly tsconfigPath: string;
	readonly tsNextPath: string;
	// These should be sorted with oldest first.
	readonly olderInstalls: ReadonlyArray<{ versionName: string, path: string }>;
}

const programCache = new WeakMap<Program, Map<string, Program>>();
/** Maps a tslint Program to one created with the version specified in `options`. */
function getProgram(configFile: string, ts: typeof TsType, versionName: string, oldProgram: Program): Program {
	let versionToProgram = programCache.get(oldProgram);
	if (versionToProgram === undefined) {
		versionToProgram = new Map<string, Program>();
		programCache.set(oldProgram, versionToProgram);
	}

	let newProgram = versionToProgram.get(versionName);
	if (newProgram === undefined) {
		newProgram = createProgram(configFile, ts);
		versionToProgram.set(versionName, newProgram);
	}
	return newProgram;
}

function createProgram(configFile: string, ts: typeof TsType): Program {
	const projectDirectory = dirname(configFile);
	const { config } = ts.readConfigFile(configFile, ts.sys.readFile);
	const parseConfigHost: TsType.ParseConfigHost = {
		fileExists: existsSync,
		readDirectory: ts.sys.readDirectory,
		readFile: file => readFileSync(file, "utf8"),
		useCaseSensitiveFileNames: true,
	};
	const parsed = ts.parseJsonConfigFileContent(config, parseConfigHost, resolvePath(projectDirectory), {noEmit: true});
	const host = ts.createCompilerHost(parsed.options, true);
	return ts.createProgram(parsed.fileNames, parsed.options, host);
}

function walk(
		ctx: Lint.WalkContext<void>,
		program: Program,
		ts: typeof TsType,
		versionName: string,
		nextHigherVersion: string | undefined): void {
	const sourceFile = program.getSourceFile(ctx.sourceFile.fileName);

	const checker = program.getTypeChecker();
	// Don't care about emit errors.
	const diagnostics = ts.getPreEmitDiagnostics(program, sourceFile);

	if (sourceFile.isDeclarationFile || !/\$Expect(Type|Error)/.test(sourceFile.text)) {
		// Normal file.
		for (const diagnostic of diagnostics) {
			addDiagnosticFailure(diagnostic);
		}
		return;
	}

	const { errorLines, typeAssertions, duplicates } = parseAssertions(sourceFile, ts);

	for (const line of duplicates) {
		addFailureAtLine(line, Rule.FAILURE_STRING_DUPLICATE_ASSERTION);
	}

	const seenDiagnosticsOnLine = new Set<number>();

	for (const diagnostic of diagnostics) {
		const line = lineOfPosition(diagnostic.start!, sourceFile);
		seenDiagnosticsOnLine.add(line);
		if (!errorLines.has(line)) {
			addDiagnosticFailure(diagnostic);
		}
	}

	for (const line of errorLines) {
		if (!seenDiagnosticsOnLine.has(line)) {
			addFailureAtLine(line, Rule.FAILURE_STRING_EXPECTED_ERROR);
		}
	}

	const { unmetExpectations, unusedAssertions } = getExpectTypeFailures(sourceFile, typeAssertions, checker, ts);
	for (const { node, expected, actual } of unmetExpectations) {
		ctx.addFailureAtNode(node, Rule.FAILURE_STRING(expected, actual));
	}
	for (const line of unusedAssertions) {
		addFailureAtLine(line, Rule.FAILURE_STRING_ASSERTION_MISSING_NODE);
	}

	function addDiagnosticFailure(diagnostic: TsType.Diagnostic): void {
		const intro = getIntro();
		if (diagnostic.file === sourceFile) {
			const msg = `${intro}\n${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`;
			ctx.addFailureAt(diagnostic.start!, diagnostic.length!, msg);
		} else {
			const fileName = diagnostic.file ? `${diagnostic.file.fileName}: ` : "";
			ctx.addFailureAt(0, 0, `${intro}\n${fileName}${diagnostic.messageText}`);
		}
	}

	function getIntro(): string {
		if (nextHigherVersion === undefined) {
			return `TypeScript@${versionName} compile error: `;
		} else {
			const msg = `Compile error in typescript@${versionName} but not in typescript@${nextHigherVersion}.\n`;
			const explain = nextHigherVersion === "next"
				? "TypeScript@next features not yet supported."
				: `Fix with a comment '// TypeScript Version: ${nextHigherVersion}' just under the header.`;
			return msg + explain;
		}
	}

	function addFailureAtLine(line: number, failure: string): void {
		const start = sourceFile.getPositionOfLineAndCharacter(line, 0);
		let end = start + sourceFile.text.split("\n")[line].length;
		if (sourceFile.text[end - 1] === "\r") {
			end--;
		}
		ctx.addFailure(start, end, failure);
	}
}

interface Assertions {
	/** Lines with an $ExpectError. */
	readonly errorLines: ReadonlySet<number>;
	/** Map from a line number to the expected type at that line. */
	readonly typeAssertions: Map<number, string>;
	/** Lines with more than one assertion (these are errors). */
	readonly duplicates: ReadonlyArray<number>;
}

function parseAssertions(source: SourceFile, ts: typeof TsType): Assertions {
	const scanner = ts.createScanner(
		ts.ScriptTarget.Latest, /*skipTrivia*/false, ts.LanguageVariant.Standard, source.text);
	const errorLines = new Set<number>();
	const typeAssertions = new Map<number, string>();
	const duplicates: number[] = [];

	let prevTokenPos = -1;
	const lineStarts = source.getLineStarts();
	let curLine = 0;

	const getLine = (pos: number) => {
		// advance curLine to be the line preceding 'pos'
		while (lineStarts[curLine + 1] <= pos) {
			curLine++;
		}
		const isFirstTokenOnLine = lineStarts[curLine] > prevTokenPos;
		// If this is the first token on the line, it applies to the next line.
		// Otherwise, it applies to the text to the left of it.
		return isFirstTokenOnLine ? curLine + 1 : curLine;
	};

	loop: while (true) {
		const token = scanner.scan();
		const pos = scanner.getTokenPos();
		switch (token) {
			case ts.SyntaxKind.EndOfFileToken:
				break loop;

			case ts.SyntaxKind.WhitespaceTrivia:
				continue loop;

			case ts.SyntaxKind.SingleLineCommentTrivia:
				const commentText = scanner.getTokenText();
				const match = commentText.match(/^\/\/ \$Expect((Type (.*))|Error)/);
				if (match) {
					const line = getLine(pos);
					if (match[1] === "Error") {
						if (errorLines.has(line)) {
							duplicates.push(line);
						}
						errorLines.add(line);
					} else {
						const expectedType = match[3];
						// Don't bother with the assertion if there are 2 assertions on 1 line. Just fail for the duplicate.
						if (typeAssertions.delete(line)) {
							duplicates.push(line);
						} else {
							typeAssertions.set(line, expectedType);
						}
					}
				}
				break;

			default:
				prevTokenPos = pos;
				break;
		}
	}

	return { errorLines, typeAssertions, duplicates };
}

interface ExpectTypeFailures {
	/** Lines with an $ExpectType, but a different type was there. */
	readonly unmetExpectations: ReadonlyArray<{ node: TsType.Node, expected: string, actual: string }>;
	/** Lines with an $ExpectType, but no node could be found. */
	readonly unusedAssertions: Iterable<number>;
}

function getExpectTypeFailures(
		sourceFile: SourceFile,
		typeAssertions: Map<number, string>,
		checker: TsType.TypeChecker,
		ts: typeof TsType,
		): ExpectTypeFailures {
	const unmetExpectations: Array<{ node: TsType.Node, expected: string, actual: string }> = [];
	// Match assertions to the first node that appears on the line they apply to.
	ts.forEachChild(sourceFile, iterate);
	return { unmetExpectations, unusedAssertions: typeAssertions.keys() };

	function iterate(node: TsType.Node): void {
		const line = lineOfPosition(node.getStart(sourceFile), sourceFile);
		const expected = typeAssertions.get(line);
		if (expected !== undefined) {
			// https://github.com/Microsoft/TypeScript/issues/14077
			if (node.kind === ts.SyntaxKind.ExpressionStatement) {
				node = (node as TsType.ExpressionStatement).expression;
			}

			const type = checker.getTypeAtLocation(node);

			const actual = fixupUnions(checker.typeToString(type, /*enclosingDeclaration*/ undefined, ts.TypeFormatFlags.NoTruncation));
			if (actual !== expected) {
				unmetExpectations.push({ node, expected, actual });
			}

			typeAssertions.delete(line);
		}

		ts.forEachChild(node, iterate);
	}
}

function fixupUnions(s: string): string {
	const splitter = " | ";
	return s.split(splitter).map(fixupIntersections).sort().join(splitter);
}

function fixupIntersections(s: string): string {
	if (s.startsWith("(") && s.endsWith(")")) {
		return `(${fixupIntersections(s.slice(1, s.length - 1))})`;
	}
	const splitter = " & ";
	return s.split(splitter).sort().join(splitter);
}

function lineOfPosition(pos: number, sourceFile: SourceFile): number {
	return sourceFile.getLineAndCharacterOfPosition(pos).line;
}
