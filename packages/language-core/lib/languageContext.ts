import { VirtualFiles, createVirtualFiles } from './virtualFiles';
import { Language, ProjectHost } from './types';
import type * as ts from 'typescript/lib/tsserverlibrary';

export function createProject(projectHost: ProjectHost, languages: Language<any, ProjectHost>[]) {

	const resolvedHost = resolveProjectHost(projectHost, languages);
	const virtualFiles = createVirtualFiles(languages);

	return {
		rawHost: projectHost,
		resolvedHost,
		virtualFiles: syncVirtualFilesWithProjectHost(virtualFiles, resolvedHost),
	};
}

function resolveProjectHost(projectHost: ProjectHost, languages: Language<any, ProjectHost>[]) {

	let host = projectHost;

	for (const language of languages.reverse()) {
		if (language.resolveProjectHost) {
			const pastHost = host;
			let proxyHost = language.resolveProjectHost(host);
			if (proxyHost === pastHost) {
				console.warn(`[volar] language.resolveHost() should not return the same host instance.`);
				proxyHost = { ...proxyHost };
			}
			host = new Proxy(proxyHost, {
				get(target, p) {
					if (p in target) {
						return (target as any)[p];
					}
					return (pastHost as any)[p];
				}
			});
		}
	}

	return host;
}

function syncVirtualFilesWithProjectHost(virtualFiles: VirtualFiles, projectHost: ProjectHost) {

	let lastRootFiles = new Map<string, ts.IScriptSnapshot | undefined>();
	let lastProjectVersion: number | string | undefined;

	return new Proxy(virtualFiles, {
		get: (target, property) => {
			sync();
			return target[property as keyof typeof virtualFiles];
		},
	});

	function sync() {

		const newProjectVersion = projectHost.getProjectVersion();
		const shouldUpdate = newProjectVersion !== lastProjectVersion;
		if (!shouldUpdate)
			return;

		const nowRootFiles = new Map<string, ts.IScriptSnapshot | undefined>();
		const remainRootFiles = new Set(lastRootFiles.keys());

		for (const rootFileName of projectHost.getScriptFileNames()) {
			nowRootFiles.set(rootFileName, projectHost.getScriptSnapshot(rootFileName));
		}

		for (const [fileName, snapshot] of nowRootFiles) {
			remainRootFiles.delete(fileName);
			if (lastRootFiles.get(fileName) !== nowRootFiles.get(fileName)) {
				if (snapshot) {
					virtualFiles.updateSource(fileName, snapshot, projectHost.getLanguageId?.(fileName));
				}
				else {
					virtualFiles.deleteSource(fileName);
				}
			}
		}

		for (const fileName of remainRootFiles) {
			virtualFiles.deleteSource(fileName);
		}

		lastRootFiles = nowRootFiles;
		lastProjectVersion = newProjectVersion;
	}
}
