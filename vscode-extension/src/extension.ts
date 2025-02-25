import * as vscode from 'vscode';
import WebSocket, { WebSocketServer, RawData } from 'ws';

interface SyncState {
    filePath: string;
    line: number;
    column: number;
    source: 'vscode' | 'jetbrains';
    isActive: boolean;
    action?: 'close';  // Add action field for document close events
}

export class VSCodeJetBrainsSync {
    private wss: WebSocketServer | null = null;
    private jetbrainsClient: WebSocket | null = null;
    private disposables: vscode.Disposable[] = [];
    private currentState: SyncState | null = null;
    private isActive: boolean = false;
    private statusBarItem: vscode.StatusBarItem;
    private isConnected: boolean = false;
    private autoReconnect: boolean = false;

    constructor() {
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.statusBarItem.command = 'vscode-jetbrains-sync.toggleAutoReconnect';
        this.updateStatusBarItem();
        this.statusBarItem.show();
        
        // Initialize WebSocket server
        this.setupServer();
        this.setupEditorListeners();
        this.setupWindowListeners();
        this.isActive = vscode.window.state.focused;
    }

    private updateStatusBarItem() {
        let icon = '$(sync~spin)';
        if (this.isConnected) {
            icon = '$(check)';
        } else if (!this.autoReconnect) {
            icon = '$(sync-ignored)';
        }
        
        this.statusBarItem.text = `${icon} ${this.autoReconnect ? 'IDE Sync On' : 'Turn IDE Sync On'}`;
        this.statusBarItem.tooltip = `${this.isConnected ? 'Connected to JetBrains IDE\n' : 'Waiting for JetBrains IDE connection\n'}Click to turn sync ${this.autoReconnect ? 'off' : 'on'}`;
    }

    public toggleAutoReconnect() {
        this.autoReconnect = !this.autoReconnect;
        
        if (!this.autoReconnect) {
            // Close existing connections when turning sync off
            if (this.jetbrainsClient) {
                this.jetbrainsClient.close();
                this.jetbrainsClient = null;
            }
            if (this.wss) {
                this.wss.close(() => {
                    console.log('WebSocket server closed');
                });
                this.wss = null;
            }
            this.isConnected = false;
            vscode.window.showInformationMessage('Sync disabled');
        } else {
            vscode.window.showInformationMessage('Sync enabled');
            this.setupServer();
        }
        
        this.updateStatusBarItem();
    }

    private setupServer() {
        if (!this.autoReconnect) {
            return;
        }

        if (this.wss) {
            this.wss.close(() => {
                console.log('Closing existing WebSocket server');
            });
        }

        const port = vscode.workspace.getConfiguration('vscode-jetbrains-sync').get('port', 3000);
        this.wss = new WebSocketServer({ port });
        console.log(`Starting WebSocket server on port ${port}...`);
        
        this.wss.on('connection', (ws: WebSocket, request) => {
            const clientType = request.url?.slice(1); // Remove leading slash

            if (clientType === 'jetbrains') {
                if (this.jetbrainsClient) {
                    this.jetbrainsClient.close();
                }
                this.jetbrainsClient = ws;
                this.isConnected = true;
                this.updateStatusBarItem();
                console.log('JetBrains IDE client connected');
                vscode.window.showInformationMessage('JetBrains IDE connected');
            } else {
                ws.close();
                return;
            }

            ws.on('message', (data: RawData) => {
                try {
                    const state: SyncState = JSON.parse(data.toString());
                    this.handleIncomingState(state);
                } catch (error) {
                    console.error('Error parsing message:', error);
                    vscode.window.showErrorMessage('Error handling sync message');
                }
            });

            ws.on('close', () => {
                if (this.jetbrainsClient === ws) {
                    this.jetbrainsClient = null;
                    this.isConnected = false;
                    this.updateStatusBarItem();
                    console.log('JetBrains IDE client disconnected');
                    vscode.window.showWarningMessage('JetBrains IDE disconnected');
                }
            });

            ws.on('error', (error: Error) => {
                console.error('WebSocket error:', error);
                this.isConnected = false;
                this.updateStatusBarItem();
                vscode.window.showErrorMessage('WebSocket error occurred');
            });
        });

        this.wss.on('listening', () => {
            console.log(`WebSocket server is listening on port ${port}`);
        });

        this.wss.on('error', (error: Error) => {
            console.error('WebSocket server error:', error);
            vscode.window.showErrorMessage('Failed to start WebSocket server');
        });
    }

    private setupEditorListeners() {
        // Listen for active editor changes
        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor((editor) => {
                if (editor && !this.isHandlingExternalUpdate) {
                    const document = editor.document;
                    const position = editor.selection.active;
                    this.updateState({
                        filePath: document.uri.fsPath,
                        line: position.line,
                        column: position.character,
                        source: 'vscode',
                        isActive: this.isActive
                    });
                }
            })
        );

        // Listen for document close events
        this.disposables.push(
            vscode.workspace.onDidCloseTextDocument((document) => {
                if (!this.isHandlingExternalUpdate) {
                    this.updateState({
                        filePath: document.uri.fsPath,
                        line: 0,
                        column: 0,
                        source: 'vscode',
                        isActive: this.isActive,
                        action: 'close'
                    });
                }
            })
        );

        // Listen for cursor position changes
        this.disposables.push(
            vscode.window.onDidChangeTextEditorSelection((event) => {
                if (event.textEditor === vscode.window.activeTextEditor && !this.isHandlingExternalUpdate) {
                    const document = event.textEditor.document;
                    const position = event.selections[0].active;
                    this.updateState({
                        filePath: document.uri.fsPath,
                        line: position.line,
                        column: position.character,
                        source: 'vscode',
                        isActive: this.isActive
                    });
                }
            })
        );
    }

    private setupWindowListeners() {
        this.disposables.push(
            vscode.window.onDidChangeWindowState((e) => {
                this.isActive = e.focused;
                if (this.currentState) {
                    const state: SyncState = {
                        ...this.currentState,
                        isActive: this.isActive,
                        source: 'vscode'
                    };
                    this.updateState(state);
                }
            })
        );
    }

    private isHandlingExternalUpdate = false;

    private async handleIncomingState(state: SyncState) {
        if (state.source === 'vscode') {
            return; // Ignore our own updates
        }

        // Only handle incoming state if the other IDE is active
        if (!state.isActive) {
            console.log('Ignoring update from inactive JetBrains IDE');
            return;
        }

        try {
            this.isHandlingExternalUpdate = true;
            
            // Handle document close action
            if (state.action === 'close') {
                const openEditors = vscode.window.visibleTextEditors;
                const editorToClose = openEditors.find(editor => editor.document.uri.fsPath === state.filePath);
                if (editorToClose) {
                    await vscode.window.showTextDocument(editorToClose.document);
                    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                }
                return;
            }

            const uri = vscode.Uri.file(state.filePath);
            const document = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(document, {preview: false});
            
            const position = new vscode.Position(state.line, state.column);
            editor.selection = new vscode.Selection(position, position);
            
            editor.revealRange(
                new vscode.Range(position, position),
                vscode.TextEditorRevealType.InCenter
            );
        } catch (error) {
            console.error('Error handling incoming state:', error);
            vscode.window.showErrorMessage(`Failed to open file: ${state.filePath}`);
        } finally {
            this.isHandlingExternalUpdate = false;
        }
    }

    public updateState(state: SyncState) {
        this.currentState = state;
        if (this.jetbrainsClient?.readyState === WebSocket.OPEN) {
            try {
                // Only send updates if we're active
                if (this.isActive) {
                    console.log('Sending state update (VSCode is active):', state);
                    this.jetbrainsClient.send(JSON.stringify(state));
                } else {
                    console.log('Skipping state update (VSCode is not active)');
                }
            } catch (error) {
                console.error('Error sending state:', error);
                vscode.window.showErrorMessage('Failed to sync VSCode position');
            }
        }
    }

    public dispose() {
        if (this.wss) {
            this.wss.close(() => {
                console.log('WebSocket server closed');
            });
        }
        this.statusBarItem.dispose();
        this.disposables.forEach(d => d.dispose());
    }
}

// Export activation and deactivation functions
let syncInstance: VSCodeJetBrainsSync | null = null;

export function activate(context: vscode.ExtensionContext) {
    syncInstance = new VSCodeJetBrainsSync();
    
    context.subscriptions.push(
        vscode.commands.registerCommand('vscode-jetbrains-sync.toggleAutoReconnect', () => {
            syncInstance?.toggleAutoReconnect();
        })
    );
    
    context.subscriptions.push({
        dispose: () => syncInstance?.dispose()
    });
}

export function deactivate() {
    syncInstance?.dispose();
} 