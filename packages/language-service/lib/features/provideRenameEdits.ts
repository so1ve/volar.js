import { isRenameEnabled, type CodeInformation, resolveRenameNewName } from '@volar/language-core';
import type * as vscode from 'vscode-languageserver-protocol';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { ServiceContext } from '../types';
import { NoneCancellationToken } from '../utils/cancellation';
import * as dedupe from '../utils/dedupe';
import { languageFeatureWorker } from '../utils/featureWorkers';
import { pushEditToDocumentChanges, transformWorkspaceEdit } from '../utils/transform';

export function register(context: ServiceContext) {

	return (uri: string, position: vscode.Position, newName: string, token = NoneCancellationToken) => {

		return languageFeatureWorker(
			context,
			uri,
			() => ({ position, newName }),
			function* (map) {
				let _data!: CodeInformation;
				for (const mappedPosition of map.getGeneratedPositions(position, data => {
					_data = data;
					return isRenameEnabled(data);
				})) {
					yield {
						position: mappedPosition,
						newName: resolveRenameNewName(newName, _data),
					};
				};
			},
			async (service, document, params) => {

				if (token.isCancellationRequested) {
					return;
				}

				const recursiveChecker = dedupe.createLocationSet();
				let result: vscode.WorkspaceEdit | undefined;

				await withMirrors(document, params.position, params.newName);

				return result;

				async function withMirrors(document: TextDocument, position: vscode.Position, newName: string) {

					if (!service[1].provideRenameEdits) {
						return;
					}

					if (recursiveChecker.has({ uri: document.uri, range: { start: position, end: position } })) {
						return;
					}

					recursiveChecker.add({ uri: document.uri, range: { start: position, end: position } });

					const workspaceEdit = await service[1].provideRenameEdits(document, position, newName, token);

					if (!workspaceEdit) {
						return;
					}

					if (!result) {
						result = {};
					}

					if (workspaceEdit.changes) {

						for (const editUri in workspaceEdit.changes) {

							const textEdits = workspaceEdit.changes[editUri];

							for (const textEdit of textEdits) {

								let foundMirrorPosition = false;

								recursiveChecker.add({ uri: editUri, range: { start: textEdit.range.start, end: textEdit.range.start } });

								const [virtualFile] = context.language.files.getVirtualFile(context.env.uriToFileName(editUri));
								const mirrorMap = virtualFile ? context.documents.getLinkedCodeMap(virtualFile) : undefined;

								if (mirrorMap) {

									for (const linkedPos of mirrorMap.getLinkedCodePositions(textEdit.range.start)) {

										if (recursiveChecker.has({ uri: mirrorMap.document.uri, range: { start: linkedPos, end: linkedPos } })) {
											continue;
										}

										foundMirrorPosition = true;

										await withMirrors(mirrorMap.document, linkedPos, newName);
									}
								}

								if (!foundMirrorPosition) {

									if (!result.changes) {
										result.changes = {};
									}

									if (!result.changes[editUri]) {
										result.changes[editUri] = [];
									}

									result.changes[editUri].push(textEdit);
								}
							}
						}
					}

					if (workspaceEdit.changeAnnotations) {

						for (const uri in workspaceEdit.changeAnnotations) {

							if (!result.changeAnnotations) {
								result.changeAnnotations = {};
							}

							result.changeAnnotations[uri] = workspaceEdit.changeAnnotations[uri];
						}
					}

					if (workspaceEdit.documentChanges) {

						if (!result.documentChanges) {
							result.documentChanges = [];
						}

						result.documentChanges = result.documentChanges.concat(workspaceEdit.documentChanges);
					}
				}
			},
			(data) => {
				return transformWorkspaceEdit(
					data,
					context,
					'rename',
				);
			},
			(workspaceEdits) => {

				const mainEdit = workspaceEdits[0];
				const otherEdits = workspaceEdits.slice(1);

				mergeWorkspaceEdits(mainEdit, ...otherEdits);

				if (mainEdit.changes) {
					for (const uri in mainEdit.changes) {
						mainEdit.changes[uri] = dedupe.withTextEdits(mainEdit.changes[uri]);
					}
				}

				return workspaceEdits[0];
			},
		);
	};
}

export function mergeWorkspaceEdits(original: vscode.WorkspaceEdit, ...others: vscode.WorkspaceEdit[]) {
	for (const other of others) {
		for (const uri in other.changeAnnotations) {
			if (!original.changeAnnotations) {
				original.changeAnnotations = {};
			}
			original.changeAnnotations[uri] = other.changeAnnotations[uri];
		}
		for (const uri in other.changes) {
			if (!original.changes) {
				original.changes = {};
			}
			if (!original.changes[uri]) {
				original.changes[uri] = [];
			}
			const edits = other.changes[uri];
			original.changes[uri] = original.changes[uri].concat(edits);
		}
		if (other.documentChanges) {
			if (!original.documentChanges) {
				original.documentChanges = [];
			}
			for (const docChange of other.documentChanges) {
				pushEditToDocumentChanges(original.documentChanges, docChange);
			}
		}
	}
}
