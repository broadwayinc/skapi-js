const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const SKAPI_FILE = path.resolve(__dirname, 'skapi.ts');
const OUTPUT_DIR = path.resolve(path.dirname(SKAPI_FILE), 'ref');
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const TSCONFIG_PATH = path.resolve(PROJECT_ROOT, 'tsconfig.json');

console.log(`[typedoc] Generating MD file(s) in ${OUTPUT_DIR}/...`);

function fail(message) {
	console.error(`[typedoc] ${message}`);
	process.exit(1);
}

function toPosix(p) {
	return p.split(path.sep).join('/');
}

function sanitizeFileName(name) {
	return name.replace(/[^A-Za-z0-9_$.-]/g, '_');
}

function getNameText(nameNode) {
	if (!nameNode) {
		return null;
	}
	if (ts.isIdentifier(nameNode)) {
		return nameNode.text;
	}
	if (ts.isStringLiteral(nameNode) || ts.isNumericLiteral(nameNode)) {
		return nameNode.text;
	}
	return nameNode.getText();
}

function hasModifier(node, kind) {
	return !!(node.modifiers && node.modifiers.some(modifier => modifier.kind === kind));
}

function loadTsConfig(configPath) {
	const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
	if (configFile.error) {
		const msg = ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n');
		fail(`Unable to read tsconfig: ${msg}`);
	}

	const parsed = ts.parseJsonConfigFileContent(
		configFile.config,
		ts.sys,
		path.dirname(configPath)
	);

	if (parsed.errors && parsed.errors.length) {
		const msg = parsed.errors
			.map(e => ts.flattenDiagnosticMessageText(e.messageText, '\n'))
			.join('\n');
		fail(`Invalid tsconfig: ${msg}`);
	}

	return parsed;
}

function findSkapiClass(sourceFile) {
	let found = null;

	sourceFile.forEachChild(node => {
		if (found) {
			return;
		}
		if (ts.isClassDeclaration(node) && node.name && node.name.text === 'Skapi') {
			found = node;
		}
	});

	return found;
}

function formatDocTags(tags) {
	if (!tags || tags.length === 0) {
		return '';
	}

	return tags
		.map(tag => {
			const text = (tag.text || []).map(t => t.text).join('').trim();
			return text ? `@${tag.name} ${text}` : `@${tag.name}`;
		})
		.join('\n');
}

function collectReferencedTypeSymbols(methodDecl, checker) {
	const symbols = new Map();

	function addSymbolFromEntityName(entityName) {
		let symbol = checker.getSymbolAtLocation(entityName);
		if (!symbol && ts.isQualifiedName(entityName)) {
			symbol = checker.getSymbolAtLocation(entityName.right);
		}
		if (!symbol) {
			return;
		}
		if (symbol.flags & ts.SymbolFlags.Alias) {
			symbol = checker.getAliasedSymbol(symbol);
		}
		if (!symbol) {
			return;
		}

		const key = checker.getFullyQualifiedName(symbol);
		if (!symbols.has(key)) {
			symbols.set(key, symbol);
		}
	}

	function visit(node) {
		if (!node) {
			return;
		}

		if (ts.isTypeReferenceNode(node)) {
			addSymbolFromEntityName(node.typeName);
		}

		if (ts.isExpressionWithTypeArguments(node) && node.expression) {
			const expr = node.expression;
			if (ts.isIdentifier(expr) || ts.isQualifiedName(expr)) {
				addSymbolFromEntityName(expr);
			}
		}

		ts.forEachChild(node, visit);
	}

	for (const typeParam of methodDecl.typeParameters || []) {
		if (typeParam.constraint) {
			visit(typeParam.constraint);
		}
		if (typeParam.default) {
			visit(typeParam.default);
		}
	}

	for (const param of methodDecl.parameters || []) {
		if (param.type) {
			visit(param.type);
		}
	}

	if (methodDecl.type) {
		visit(methodDecl.type);
	}

	return Array.from(symbols.values());
}

function isProjectTypeDeclaration(declFilePath) {
	const normalized = path.resolve(declFilePath);
	const inProjectSrc = normalized.startsWith(path.resolve(PROJECT_ROOT, 'src') + path.sep);
	const inNodeModules = normalized.includes(`${path.sep}node_modules${path.sep}`);
	const isDeclarationFile = normalized.endsWith('.d.ts');
	const sameAsSkapi = normalized === SKAPI_FILE;

	return inProjectSrc && !inNodeModules && !isDeclarationFile && !sameAsSkapi;
}

function getResolvedTypeSections(typeSymbols, checker) {
	const sections = [];
	const seen = new Set();

	for (const symbol of typeSymbols) {
		const declarations = symbol.declarations || [];

		let picked = null;
		for (const decl of declarations) {
			const filePath = decl.getSourceFile().fileName;
			if (isProjectTypeDeclaration(filePath)) {
				picked = decl;
				break;
			}
		}

		if (!picked) {
			continue;
		}

		const sourceFile = picked.getSourceFile();
		const sourcePath = path.resolve(sourceFile.fileName);
		const key = `${sourcePath}:${picked.pos}:${picked.end}`;

		if (seen.has(key)) {
			continue;
		}
		seen.add(key);

		const symbolName = symbol.getName();
		const doc = ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim();
		const tags = formatDocTags(symbol.getJsDocTags());
		const rel = toPosix(path.relative(PROJECT_ROOT, sourcePath));

		let section = `### ${symbolName}\n\n`;
		// section += `Source: ${rel}\n\n`;

		if (doc) {
			section += `${doc}\n\n`;
		}
		if (tags) {
			section += `${tags}\n\n`;
		}

		section += '```ts\n';
		section += `${picked.getText()}\n`;
		section += '```\n';

		sections.push(section);
	}

	return sections;
}

function buildMethodMarkdown(methodDecl, checker, sourceFile) {
	const methodName = getNameText(methodDecl.name);
	if (!methodName) {
		return null;
	}

	const symbol = checker.getSymbolAtLocation(methodDecl.name);
	if (!symbol) {
		return null;
	}

	const methodType = checker.getTypeOfSymbolAtLocation(symbol, methodDecl);
	const signatures = checker.getSignaturesOfType(methodType, ts.SignatureKind.Call);
	const signatureLines = signatures.map(sig =>
		`${methodName}${checker.signatureToString(sig, methodDecl, ts.TypeFormatFlags.NoTruncation)}`
	);

	const docs = ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim();
	const tags = formatDocTags(symbol.getJsDocTags());

	const typeSymbols = collectReferencedTypeSymbols(methodDecl, checker);
	const resolvedTypeSections = getResolvedTypeSections(typeSymbols, checker);

	let content = `# ${methodName}\n\n`;
	content += '## Signature\n\n';
	content += '```ts\n';
	content += `${signatureLines.join('\n')}\n`;
	content += '```\n\n';

	content += '## Documentation\n\n';
	if (docs) {
		content += `${docs}\n\n`;
	} else {
		content += '_No documentation comment found._\n\n';
	}

	if (tags) {
		content += '```text\n';
		content += `${tags}\n`;
		content += '```\n\n';
	}

	content += '## Resolved Imported Types\n\n';
	if (resolvedTypeSections.length) {
		content += `${resolvedTypeSections.join('\n')}\n`;
	} else {
		content += '_No imported type definitions referenced by this method._\n';
	}

	return {
		methodName,
		content
	};
}

function main() {
	if (!fs.existsSync(SKAPI_FILE)) {
		fail(`Cannot find skapi.ts at ${SKAPI_FILE}`);
	}

	const parsed = loadTsConfig(TSCONFIG_PATH);
	const program = ts.createProgram({
		rootNames: parsed.fileNames,
		options: parsed.options
	});
	const checker = program.getTypeChecker();

	const sourceFile = program.getSourceFiles().find(sf => path.resolve(sf.fileName) === SKAPI_FILE);
	if (!sourceFile) {
		fail('skapi.ts is not part of the TypeScript program.');
	}

	const skapiClass = findSkapiClass(sourceFile);
	if (!skapiClass) {
		fail('Could not find class Skapi in skapi.ts.');
	}

	fs.mkdirSync(OUTPUT_DIR, { recursive: true });

	const methods = skapiClass.members.filter(member => {
		if (!ts.isMethodDeclaration(member)) {
			return false;
		}

		if (hasModifier(member, ts.SyntaxKind.PrivateKeyword)) {
			return false;
		}

		const methodName = getNameText(member.name);
		if (!methodName || methodName.startsWith('_')) {
			return false;
		}

		return true;
	});
	if (!methods.length) {
		fail('No methods found in class Skapi.');
	}

	let generated = 0;

	for (const member of methods) {
		const doc = buildMethodMarkdown(member, checker, sourceFile);
		if (!doc) {
			continue;
		}

		const fileName = `${sanitizeFileName(doc.methodName)}.md`;
		const outputPath = path.join(OUTPUT_DIR, fileName);
		fs.writeFileSync(outputPath, doc.content, 'utf8');
		generated += 1;
	}

	console.log(`[typedoc] Generated ${generated} file(s) in ${OUTPUT_DIR}`);
}

main();
