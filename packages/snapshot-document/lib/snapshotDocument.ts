import type * as ts from 'typescript';
import type * as vscode from 'vscode-languageserver-protocol';
import { Range, TextDocument } from 'vscode-languageserver-textdocument';
import { combineChangeRanges } from './combine';

export class SnapshotDocument implements TextDocument {

	private document: TextDocument;
	private snapshots: {
		changeRange: ts.TextChangeRange;
		version: number;
		ref: WeakRef<ts.IScriptSnapshot> | undefined;
	}[] = [];

	constructor(
		uri: string,
		languageId: string,
		version: number,
		text: string
	) {
		this.document = TextDocument.create(uri, languageId, version, text);
		this.resetChanges();
	}

	get uri() {
		return this.document.uri;
	}

	get languageId() {
		return this.document.languageId;
	}

	get version() {
		return this.document.version;
	}

	get lineCount() {
		return this.document.lineCount;
	}

	getText(range?: Range) {
		return this.document.getText(range);
	}

	positionAt(offset: number) {
		return this.document.positionAt(offset);
	}

	offsetAt(position: vscode.Position) {
		return this.document.offsetAt(position);
	}

	/**
	 * Update the document with the given content changes and version.
	 * If all changes is incremental, calculate the change range and add a new snapshot.
	 * Otherwise, reset the changes.
	 */
	update(contentChanges: vscode.TextDocumentContentChangeEvent[], version: number) {
		if (contentChanges.every(change => 'range' in change)) {
			const { minStart, oldLength, lengthDiff } = this.calculateChangeRange(contentChanges);
			TextDocument.update(this.document, contentChanges, version);
			this.snapshots.push({
				changeRange: {
					span: {
						start: minStart,
						length: oldLength,
					},
					newLength: oldLength + lengthDiff,
				},
				version,
				ref: undefined,
			});
		}
		else {
			TextDocument.update(this.document, contentChanges, version);
			this.resetChanges();
		}
	}

	getSnapshot() {

		this.clearUnreferencedVersions();

		const lastChange = this.snapshots[this.snapshots.length - 1];
		if (!lastChange.ref) {
			const text = this.document.getText();
			const changeRangeCache = new WeakMap<ts.IScriptSnapshot, ts.TextChangeRange | undefined>();
			const snapshot: ts.IScriptSnapshot = {
				getText: (start, end) => text.substring(start, end),
				getLength: () => text.length,
				getChangeRange: (oldSnapshot) => {
					if (!changeRangeCache.has(oldSnapshot)) {
						const oldIndex = this.snapshots.findIndex(change => change.ref?.deref() === oldSnapshot);
						if (oldIndex >= 0) {
							const start = oldIndex + 1;
							const end = this.snapshots.indexOf(lastChange) + 1;
							const changeRanges = this.snapshots
								.slice(start, end)
								.map(change => change.changeRange);
							const changeRange = combineChangeRanges(...changeRanges);
							changeRangeCache.set(oldSnapshot, changeRange);
						}
						else {
							changeRangeCache.set(oldSnapshot, undefined);
						}
					}
					return changeRangeCache.get(oldSnapshot);
				},
			};
			lastChange.ref = new WeakRef(snapshot);
		}

		return lastChange.ref.deref()!;
	}

	private resetChanges() {
		this.snapshots = [
			{
				changeRange: {
					span: {
						start: 0,
						length: 0,
					},
					newLength: this.document.getText().length,
				},
				version: this.document.version,
				ref: undefined,
			}
		];
	}

	/**
	 * Calculate the change range from the given content changes.
	 */
	private calculateChangeRange(contentChanges: vscode.TextDocumentContentChangeEvent[]) {
		let lengthDiff = 0;
		const starts: number[] = [];
		const ends: number[] = [];
		for (const contentChange of contentChanges) {
			if (!('range' in contentChange)) {
				continue;
			}
			const start = this.offsetAt(contentChange.range.start);
			const length = contentChange.rangeLength ?? this.offsetAt(contentChange.range.end) - start;
			const end = start + length;
			starts.push(start);
			ends.push(end);
			lengthDiff += contentChange.text.length - length;
		}
		const minStart = Math.min(...starts);
		const maxEnd = Math.max(...ends);
		const oldLength = maxEnd - minStart;
		return { minStart, oldLength, lengthDiff };
	}

	private clearUnreferencedVersions() {
		let firstReferencedIndex = 0;
		while (firstReferencedIndex < this.snapshots.length - 1 && !this.snapshots[firstReferencedIndex].ref?.deref()) {
			firstReferencedIndex++;
		}
		this.snapshots = this.snapshots.slice(firstReferencedIndex);
	}
}
