import type { TypeScriptProjectHost } from '@volar/language-service';
import * as path from 'typesafe-path/posix';
import * as ts from 'typescript';
import { asPosix, defaultCompilerOptions } from './utils';

export interface KitProjectHost extends TypeScriptProjectHost {
	fileUpdated(fileName: string): void;
	fileDeleted(fileName: string): void;
	fileCreated(fileName: string): void;
	reload(): void;
}

export function createInferredProjectHost(
	rootPath: string,
	getScriptFileNames: () => string[],
	compilerOptions = defaultCompilerOptions
) {
	return createProjectHostBase(
		rootPath,
		() => ({
			options: compilerOptions,
			fileNames: getScriptFileNames().map(asPosix),
		}),
	);
}

export function createProjectHost(
	sourceTsconfigPath: string,
	extraFileExtensions: ts.FileExtensionInfo[] = [],
	existingOptions?: ts.CompilerOptions
) {
	const tsconfigPath = asPosix(sourceTsconfigPath);
	return createProjectHostBase(
		path.dirname(tsconfigPath),
		() => {
			const parsed = ts.parseJsonSourceFileConfigFileContent(
				ts.readJsonConfigFile(tsconfigPath, ts.sys.readFile),
				ts.sys,
				path.dirname(tsconfigPath),
				existingOptions,
				tsconfigPath,
				undefined,
				extraFileExtensions,
			);
			parsed.fileNames = parsed.fileNames.map(asPosix);
			return parsed;
		},
	);
}

function createProjectHostBase(rootPath: string, createParsedCommandLine: () => Pick<ts.ParsedCommandLine, 'options' | 'fileNames'>): KitProjectHost {

	let scriptSnapshotsCache: Map<string, ts.IScriptSnapshot | undefined> = new Map();
	let parsedCommandLine = createParsedCommandLine();
	let projectVersion = 0;
	let shouldCheckRootFiles = false;

	return {
		workspacePath: rootPath,
		rootPath: rootPath,
		getCompilationSettings: () => {
			return parsedCommandLine.options;
		},
		getProjectVersion: () => {
			checkRootFilesUpdate();
			return projectVersion.toString();
		},
		getScriptFileNames: () => {
			checkRootFilesUpdate();
			return parsedCommandLine.fileNames;
		},
		getScriptSnapshot: (fileName) => {
			if (!scriptSnapshotsCache.has(fileName)) {
				const fileText = ts.sys.readFile(fileName, 'utf8');
				if (fileText !== undefined) {
					scriptSnapshotsCache.set(fileName, ts.ScriptSnapshot.fromString(fileText));
				}
				else {
					scriptSnapshotsCache.set(fileName, undefined);
				}
			}
			return scriptSnapshotsCache.get(fileName);
		},
		fileUpdated(fileName: string) {
			fileName = asPosix(fileName);
			if (scriptSnapshotsCache.has(fileName)) {
				projectVersion++;
				scriptSnapshotsCache.delete(fileName);
			}
		},
		fileDeleted(fileName: string) {
			fileName = asPosix(fileName);
			if (scriptSnapshotsCache.has(fileName)) {
				projectVersion++;
				scriptSnapshotsCache.delete(fileName);
				parsedCommandLine.fileNames = parsedCommandLine.fileNames.filter(name => name !== fileName);
			}
		},
		fileCreated(fileName: string) {
			fileName = asPosix(fileName);
			shouldCheckRootFiles = true;
		},
		reload() {
			scriptSnapshotsCache.clear();
			projectVersion++;
			parsedCommandLine = createParsedCommandLine();
		},
	};

	function checkRootFilesUpdate() {

		if (!shouldCheckRootFiles) return;
		shouldCheckRootFiles = false;

		const newParsedCommandLine = createParsedCommandLine();
		if (!arrayItemsEqual(newParsedCommandLine.fileNames, parsedCommandLine.fileNames)) {
			parsedCommandLine.fileNames = newParsedCommandLine.fileNames;
			projectVersion++;
		}
	}
}

function arrayItemsEqual(a: string[], b: string[]) {
	if (a.length !== b.length) {
		return false;
	}
	const set = new Set(a);
	for (const file of b) {
		if (!set.has(file)) {
			return false;
		}
	}
	return true;
}
