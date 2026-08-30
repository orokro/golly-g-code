/**
 * Type hints for the preload context bridge.
 *
 * MAINTAINED BY HAND. Anything added to src/main/preload.cjs must be mirrored
 * here or editor intellisense will silently go stale.
 */

export interface GollyAPI {
	getVersion(): Promise<string>;
	messageBox(options?: object): Promise<number>;
	onCloseRequested(handler: () => void): () => void;
	confirmClose(mayClose: boolean): Promise<boolean>;
	openFileDialog(options?: object): Promise<string[] | null>;
	saveFileDialog(options?: object): Promise<string | null>;
	readText(path: string): Promise<string>;
	readBinary(path: string): Promise<ArrayBuffer>;
	writeText(path: string, contents: string): Promise<boolean>;
	writeBinary(path: string, contents: ArrayBuffer | Uint8Array): Promise<boolean>;
}

declare global {
	interface Window {
		gollyAPI: GollyAPI;
	}
}
