// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

// Global constants
const TEMP_DIR_PREFIX = 'jsonl-viewer-window';
const TEMP_MAP_STORAGE_KEY = 'jsonlViewerTempFileMap';

// Temporary file mapping type definition
interface TempFileMapping {
    originalPath: string;
    lineIndex: number;
    timestamp: number;  // Timestamp for cleaning up expired temp files
    windowId: string;   // Window ID to distinguish between different windows
}

// Status bar item
let lineIdxStatusBarItem: vscode.StatusBarItem;

// Global extension context
let globalContext: vscode.ExtensionContext;

// Current window ID (initialized in activate)
let currentWindowId: string = '';

// Current window's temporary directory
let currentTempDir: string = '';

// Map to store the association between temporary file URI (string) and original file info
// Note: This map is only used for in-memory caching for the current window
// Persistent storage uses workspaceState
let tempFileToOriginMap = new Map<string, TempFileMapping>();

// Load temporary file mappings from workspaceState to memory
function loadTempFileMappings() {
    const storedMap = globalContext.workspaceState.get<Record<string, TempFileMapping>>(TEMP_MAP_STORAGE_KEY) || {};
    
    // Clear current memory mappings
    tempFileToOriginMap.clear();
    
    // Only load mappings belonging to the current window
    Object.entries(storedMap).forEach(([uriString, mapping]) => {
        if (mapping.windowId === currentWindowId) {
            tempFileToOriginMap.set(uriString, mapping);
        }
    });
    
    console.log(`[${currentWindowId}] Loaded ${tempFileToOriginMap.size} temporary file mappings from storage`);
}

// Save temporary file mappings to workspaceState
function saveTempFileMappings() {
    // Get existing storage
    const storedMap = globalContext.workspaceState.get<Record<string, TempFileMapping>>(TEMP_MAP_STORAGE_KEY) || {};
    
    // Remove old mappings for the current window
    Object.keys(storedMap).forEach(key => {
        if (storedMap[key].windowId === currentWindowId) {
            delete storedMap[key];
        }
    });
    
    // Add new mappings for the current window
    tempFileToOriginMap.forEach((mapping, uriString) => {
        storedMap[uriString] = mapping;
    });
    
    // Save back to storage
    globalContext.workspaceState.update(TEMP_MAP_STORAGE_KEY, storedMap);
    console.log(`[${currentWindowId}] Saved ${tempFileToOriginMap.size} temporary file mappings to storage`);
}

// Validate if temporary files exist and clean up invalid mappings
async function validateAndCleanupTempFiles(): Promise<void> {
    console.log(`[${currentWindowId}] Starting validation of temporary files`);
    
    // 创建要删除的映射URI列表
    const urisToDelete: string[] = [];
    
    // 检查每个映射的临时文件是否存在
    for (const [uriString, mapping] of tempFileToOriginMap.entries()) {
        try {
            const fileUri = vscode.Uri.parse(uriString);
            const filePath = fileUri.fsPath;
            
            // 检查文件是否存在
            await fs.promises.access(filePath, fs.constants.F_OK);
            console.log(`[${currentWindowId}] Temporary file exists: ${filePath}`);
        } catch (error) {
            // 文件不存在，将其添加到待删除列表
            console.log(`[${currentWindowId}] Temporary file does not exist, will remove mapping: ${uriString}`);
            urisToDelete.push(uriString);
        }
    }
    
    // 从映射中移除不存在的文件
    urisToDelete.forEach(uri => {
        tempFileToOriginMap.delete(uri);
    });
    
    // 如果有删除的映射，保存更新后的映射
    if (urisToDelete.length > 0) {
        console.log(`[${currentWindowId}] Removed ${urisToDelete.length} invalid temporary file mappings`);
        saveTempFileMappings();
    }
}


// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) { // Make activate async for cleanup
    // 保存扩展上下文到全局变量
    globalContext = context;
    
    // 为当前窗口生成唯一ID
    // 注意：VS Code没有直接提供窗口ID API，所以我们生成一个唯一ID
    currentWindowId = crypto.randomUUID();
    console.log(`[Activation] Generated window ID: ${currentWindowId}`);
    
    // 创建该窗口专属的临时目录路径
    currentTempDir = path.join(os.tmpdir(), `${TEMP_DIR_PREFIX}-${currentWindowId}`);
    console.log(`[Activation] Window temporary directory: ${currentTempDir}`);
    
    // --- 启动清理 ---
    // 1. 尝试从工作区状态加载临时文件映射
    loadTempFileMappings();
    
    // 2. 验证临时文件是否存在，清理不存在的映射
    await validateAndCleanupTempFiles();
    
    // 3. 确保当前窗口的临时目录存在
    try {
        await fs.promises.mkdir(currentTempDir, { recursive: true });
        console.log(`[Activation] Created/confirmed temporary directory: ${currentTempDir}`);
    } catch (error: any) {
        console.error(`[Activation] Failed to create temporary directory:`, error);
        vscode.window.showErrorMessage(`Unable to create temporary directory. The extension may not work properly.`);
    }
    
    // --- 结束启动清理 ---


	// Register commands and event handlers

	context.subscriptions.push(vscode.commands.registerCommand('json-lines-viewer.preview', openPreviewHandler));
	// Register navigation commands
	context.subscriptions.push(vscode.commands.registerCommand('json-lines-viewer.next-line', nextLineHandler));
	context.subscriptions.push(vscode.commands.registerCommand('json-lines-viewer.previous-line', previousLineHandler));
	context.subscriptions.push(vscode.commands.registerCommand('json-lines-viewer.go-to-line', goToLine));

	lineIdxStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100000);
	context.subscriptions.push(lineIdxStatusBarItem);
	// Update status bar and context key when active editor changes
	context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
	       let isTempFile = false; // Default to false
	       let activeUri: vscode.Uri | undefined;

	       if (editor) {
	           activeUri = editor.document.uri;
	           const uriString = activeUri.toString();
	           isTempFile = tempFileToOriginMap.has(uriString);
	           console.log(`Active editor changed: ${uriString}, isTempFile: ${isTempFile}. Setting context key.`);
	       } else {
	           // No active editor
	           console.log(`No active editor. Setting context key to false.`);
	       }
	       // Set the context key based on whether the active editor is a temp file
	       vscode.commands.executeCommand('setContext', 'jsonlViewer.isEditingTempFile', isTempFile);
	       // Update status bar based on the active URI (or undefined if no editor)
	       updateStatusBarForTempFile(activeUri);
	   }));



	   // Listen for closed temporary files and clean them up
	   context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(async (doc) => {
	       const uriString = doc.uri.toString();
	       const mapping = tempFileToOriginMap.get(uriString);

	       // Only handle temporary files that have a mapping record and belong to the current window
	       if (mapping && mapping.windowId === currentWindowId) {
	           console.log(`[${currentWindowId}] [Cleanup] Closed document is a tracked temporary file: ${uriString}`);
	           
	           // 1. Remove from mapping immediately
	           tempFileToOriginMap.delete(uriString);
	           console.log(`[${currentWindowId}] [Cleanup] Removed from mapping: ${uriString}`);
	           
	           // Save updated mappings
	           saveTempFileMappings();

	           // 2. Attempt to delete the temporary file
	           const tempFilePath = doc.uri.fsPath;
	           console.log(`[${currentWindowId}] [Cleanup] Attempting to clean up: ${tempFilePath}`);

	           // Slight delay before file operations to ensure the file is not still in use
	           await new Promise(resolve => setTimeout(resolve, 100));

	           try {
	               // Check if file exists before attempting to delete
	               try {
	                   await fs.promises.stat(tempFilePath);
	                   console.log(`[${currentWindowId}] [Cleanup] Temporary file exists, attempting to delete: ${tempFilePath}`);
	                   await fs.promises.unlink(tempFilePath);
	                   console.log(`[${currentWindowId}] [Cleanup] Successfully deleted temporary file: ${tempFilePath}`);

	                   // We no longer attempt to check or delete the directory, as other windows may still be using it
	                   // Only in the deactivate function will we attempt to delete the entire window's temporary directory
	               } catch (statError: any) {
	                   if (statError.code === 'ENOENT') {
	                       console.log(`[${currentWindowId}] [Cleanup] Temporary file does not exist (ENOENT), skipping deletion: ${tempFilePath}`);
	                   } else {
	                       // Log error but continue execution
						   console.error(`[${currentWindowId}] [Cleanup] Error checking file: ${statError.message}`);
	                   }
	               }
	           } catch (error: any) {
	               console.error(`[${currentWindowId}] [Cleanup] Cleanup failed for ${tempFilePath}:`, error);
	           }

	           // Status bar and context key are updated by onDidChangeActiveTextEditor when the active editor changes after the close
	       }
		   // No need for an else block, we only care about temporary files from the current window
	   }));

	// Register listener for saving temporary files
	context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(handlePreviewSave));

	   // Initialize status bar and context key on activation
	   const initialEditor = vscode.window.activeTextEditor;
	   let initialIsTempFile = false;
	   let initialActiveUri: vscode.Uri | undefined;
	   if (initialEditor) {
	       initialActiveUri = initialEditor.document.uri;
	       initialIsTempFile = tempFileToOriginMap.has(initialActiveUri.toString());
	   }
	   vscode.commands.executeCommand('setContext', 'jsonlViewer.isEditingTempFile', initialIsTempFile);
	   updateStatusBarForTempFile(initialActiveUri);
	   console.log('Extension activated, initial context key and status bar set.');
}


// ---- Helper Functions ----

// Read a file content at specified line index
// If line index <=0, return first line
// If line index exceed file's line count, return last line
// Input: 	- file's uri
// 			- line index
// Output: 	- line's content
// 			- returned line index
async function readFileAtLine(uri: vscode.Uri, lineIdx: number): Promise<[string,number]> {
	if (lineIdx<=0) {
		lineIdx = 1;
	}

	// Use fsPath for reliable path handling, especially on Windows
	const originalFilePath = uri.fsPath;
	if (!fs.existsSync(originalFilePath)) {
		throw new Error(`File not found: ${originalFilePath}`);
	}
	const fileStream = createReadStream(originalFilePath);

	const rl = createInterface({
	  input: fileStream, // Read from original file path
	  crlfDelay: Infinity
	});
	// Note: we use the crlfDelay option to recognize all instances of CR LF
	// ('\r\n') in input.txt as a single line break.
  
	// Performance improvement opportunity: avoid iterating from the beginning of file every time
	let idx = 0;
	let line='';
	for await (line of rl) {
		idx+=1;
		if (idx === lineIdx) {
			return [line, idx];
		}
  	}
	return [line, idx];
}

// Write content to a specific line in a file
// Reads all lines, replaces the target line, and writes back
async function writeFileAtLine(filePath: string, lineIdx: number, newContent: string): Promise<void> {
	// Implementation needed: Read all lines, replace the specific line, write back
	// Consider using fs.promises for async file operations
	console.log(`Attempting to write to ${filePath} at line ${lineIdx}`); // Placeholder
	// TODO: Implement file writing logic carefully (read, modify, write)
	// Example using fs.promises:
	try {
		const fs = require('fs').promises;
		const fileContent = await fs.readFile(filePath, 'utf-8');
		const lines = fileContent.split(/\r?\n/); // Split into lines, handling both LF and CRLF

		if (lineIdx > 0 && lineIdx <= lines.length) {
			// Check if the last line is empty due to a trailing newline, adjust if necessary
			// This handles cases where files might end with or without a newline
			let effectiveLastLineIndex = lines.length;
			if (lines.length > 0 && lines[lines.length - 1] === '') {
				effectiveLastLineIndex = lines.length -1; // Don't count the empty string from trailing newline
			}

			if (lineIdx <= effectiveLastLineIndex) {
				lines[lineIdx - 1] = newContent; // Replace the line (0-based index)
			} else if (lineIdx === effectiveLastLineIndex + 1) {
				// If trying to save the "next" line of a file ending without newline, append it.
				lines.push(newContent);
			} else {
				// Handle cases where lineIdx might be unexpectedly large, though readFileAtLine should prevent this.
				console.error(`writeFileAtLine: line index ${lineIdx} is out of bounds for file ${filePath} with ${effectiveLastLineIndex} effective lines.`);
				vscode.window.showErrorMessage(`Error saving: Line index ${lineIdx} is out of bounds.`);
				return; // Stop execution if index is invalid
			}

		} else if (lineIdx === 1 && lines.length === 0) {
	            // Handle writing to an empty file at line 1
	            lines[0] = newContent;
	       } else {
			console.error(`writeFileAtLine: Invalid line index ${lineIdx} for file ${filePath}`);
			vscode.window.showErrorMessage(`Error saving: Invalid line index ${lineIdx}.`);
			return; // Stop execution if index is invalid
		}

		const updatedContent = lines.join('\n'); // Join back with LF endings
		await fs.writeFile(filePath, updatedContent, 'utf-8');
		console.log(`Successfully wrote to ${filePath} at line ${lineIdx}`);
		vscode.window.setStatusBarMessage(`Saved changes to line ${lineIdx} of ${filePath.split('/').pop()}`, 3000);

	} catch (error: any) {
		console.error(`Error writing file ${filePath}:`, error);
		vscode.window.showErrorMessage(`Failed to save changes: ${error.message}`);
	}
}


// ---- Command Handlers ----

// Modified to accept optional target line for navigation commands
const openPreviewHandler = async (arg: any, targetLine?: number) => {
    let originalUri: vscode.Uri;
    let initialLine = 1; // Default to 1

    const activeEditor = vscode.window.activeTextEditor;

    // Determine the original URI
    if (arg instanceof vscode.Uri) {
        originalUri = arg;
        // If opened from explorer, try to get line from active editor if it matches
        if (activeEditor && activeEditor.document.uri.fsPath === originalUri.fsPath) {
             initialLine = activeEditor.selection.active.line + 1;
        }
    } else if (activeEditor && activeEditor.document.languageId === 'jsonl') {
        originalUri = activeEditor.document.uri;
        initialLine = activeEditor.selection.active.line + 1;
    } else {
        vscode.window.showInformationMessage("Open a JSON Lines file (.jsonl) to show a preview.");
        return;
    }

    // Override initialLine if targetLine is provided by navigation
    if (targetLine !== undefined && targetLine > 0) {
        initialLine = targetLine;
    }

    const originalFilePath = originalUri.fsPath; // Use fsPath

    try {
        // 1. Read the content of the target line from the original file
        const [lineContent, actualLineIndex] = await readFileAtLine(originalUri, initialLine);
        initialLine = actualLineIndex; // Use the actual line index read

        // 2. Format the JSON content
        let formattedJson: string;
        try {
            // Handle potentially empty lines gracefully
            if (lineContent.trim() === '') {
                formattedJson = '{}'; // 对空行使用空对象
                vscode.window.showWarningMessage(`Line ${initialLine} is empty. Opening with '{}'.`);
            } else {
                formattedJson = JSON.stringify(JSON.parse(lineContent), null, 2);
            }
        } catch (e) {
            vscode.window.showErrorMessage(`Line ${initialLine} does not contain valid JSON. Cannot open for editing.`);
            console.error("Invalid JSON on line", initialLine, ":", lineContent, e);
            return;
        }

        // 3. Create temporary file path - using window-specific temporary directory
        // Ensure temporary directory exists (already created in activate, this is extra insurance)
        await fs.promises.mkdir(currentTempDir, { recursive: true });
        const baseName = path.basename(originalFilePath);
        // Create temporary filename with timestamp to avoid conflicts
        const timestamp = Date.now();
        const tempFileName = `${baseName}_line_${initialLine}_${timestamp}.json`;
        const tempFilePath = path.join(currentTempDir, tempFileName);
        const tempFileUri = vscode.Uri.file(tempFilePath);

        // 4. Write formatted JSON to temporary file
        await fs.promises.writeFile(tempFilePath, formattedJson, 'utf-8');

        // 5. Store mapping (using URI string as key)
        const tempUriString = tempFileUri.toString();
        const tempMapping: TempFileMapping = { 
            originalPath: originalFilePath, 
            lineIndex: initialLine,
            timestamp: timestamp,
            windowId: currentWindowId
        };
        
        tempFileToOriginMap.set(tempUriString, tempMapping);
        console.log(`[${currentWindowId}] Created mapping: ${tempUriString} -> ${originalFilePath}#${initialLine}`);
        
        // Save updated mappings to workspace state
        saveTempFileMappings();

        // 6. Open temporary file in the editor
        const document = await vscode.workspace.openTextDocument(tempFileUri);
        // Ensure it opens as a normal, editable tab, not a preview tab that might auto-close
        await vscode.window.showTextDocument(document, { preview: false });

        // 7. Update status bar for the newly opened/focused temporary file
        updateStatusBarForTempFile(tempFileUri);

    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to open preview for line ${initialLine}: ${error.message}`);
        console.error("Error in openPreviewHandler:", error);
    }
};


// ---- Navigation Handlers ----
const nextLineHandler = async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const currentTempUri = editor.document.uri;
    const mapping = tempFileToOriginMap.get(currentTempUri.toString());

    if (!mapping) {
        vscode.window.showInformationMessage("Not currently editing a JSONL line preview. Use 'JSONL: Preview Line' first.");
        return;
    }

    const { originalPath, lineIndex } = mapping;
    const nextLineIndex = lineIndex + 1;

    console.log(`Navigating: From line ${lineIndex} to ${nextLineIndex} in ${originalPath}`);
    // Clean up map entry for the file we are navigating away from
    // tempFileToOriginMap.delete(currentTempUri.toString()); // Keep map entry until file is actually closed

    // Close the current editor - use workbench command
    // This assumes the temp file editor is the active one
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

    // Trigger the open handler for the next line
    // Need a slight delay to ensure the close command finishes? Usually not.
    await openPreviewHandler(vscode.Uri.file(originalPath), nextLineIndex);
};

const previousLineHandler = async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const currentTempUri = editor.document.uri;
    const mapping = tempFileToOriginMap.get(currentTempUri.toString());

    if (!mapping) {
        vscode.window.showInformationMessage("Not currently editing a JSONL line preview. Use 'JSONL: Preview Line' first.");
        return;
    }

    const { originalPath, lineIndex } = mapping;
    const prevLineIndex = lineIndex - 1;

    if (prevLineIndex < 1) {
        vscode.window.showInformationMessage("Already at the first line.");
        return;
    }

    console.log(`Navigating: From line ${lineIndex} to ${prevLineIndex} in ${originalPath}`);
    // tempFileToOriginMap.delete(currentTempUri.toString()); // Keep map entry

    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await openPreviewHandler(vscode.Uri.file(originalPath), prevLineIndex);
};


const goToLine = async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    let originalPath: string;
    let currentLine: number | undefined;
    let currentTempUriString: string | undefined;

    // Check if currently editing a temp file to get context
    const activeUri = editor.document.uri;
    const mapping = tempFileToOriginMap.get(activeUri.toString());

    if (mapping) {
        originalPath = mapping.originalPath;
        currentLine = mapping.lineIndex;
        currentTempUriString = activeUri.toString();
    } else if (editor.document.languageId === 'jsonl') {
        // If the active editor is the original JSONL file
        originalPath = editor.document.uri.fsPath;
        currentLine = editor.selection.active.line + 1;
    } else {
         vscode.window.showInformationMessage("Please open a JSON Lines file (.jsonl) or a JSONL line preview first.");
        return;
    }

	const lineIdxStr = await vscode.window.showInputBox({
        prompt: `Go to line in ${path.basename(originalPath)}`,
        value: currentLine ? String(currentLine) : '', // Pre-fill current line
        placeHolder: `Enter line number`,
        validateInput: text => {
            const num = parseInt(text);
            return (!isNaN(num) && num > 0) ? null : 'Please enter a positive number.';
        }
    });

    if (lineIdxStr === undefined) {
        return; // User cancelled
    }

    const targetLineIdx = parseInt(lineIdxStr);

	if (targetLineIdx !== null && targetLineIdx !== currentLine){ // Only navigate if different
        if (currentTempUriString) {
            // If currently in a temp file editor, close it before navigating
            console.log(`Navigating: Closing ${currentTempUriString}, Opening line ${targetLineIdx} from ${originalPath}`);
            // tempFileToOriginMap.delete(currentTempUriString); // Keep map entry
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        }
		await openPreviewHandler(vscode.Uri.file(originalPath), targetLineIdx);
	}
};

// Update status bar using the mapping
function updateStatusBarForTempFile(activeUri?: vscode.Uri): void {
    const editor = vscode.window.activeTextEditor;
    let showStatus = false;
    let statusText = '';
    let statusTooltip = '';

    // Determine the URI to check - first the provided URI, then the active editor's URI
    const uriToCheck = activeUri || (editor ? editor.document.uri : undefined);

    if (uriToCheck) {
        const uriString = uriToCheck.toString();
        const mapping = tempFileToOriginMap.get(uriString);
        if (mapping) {
            const originalFileName = path.basename(mapping.originalPath);
            // Show window ID prefix to help users identify temporary files from different windows
            statusText = `Editing JSONL: ${originalFileName} (Line ${mapping.lineIndex})`;
            statusTooltip = `Original: ${mapping.originalPath} | Window ID: ${mapping.windowId.substring(0, 8)}...`;
            showStatus = true;
            // Potential future enhancement: add command to return to original file
            // lineIdxStatusBarItem.command = '???';
        }
    }

    if (showStatus) {
        lineIdxStatusBarItem.text = statusText;
        lineIdxStatusBarItem.tooltip = statusTooltip;
        lineIdxStatusBarItem.show();
    } else {
        lineIdxStatusBarItem.hide();
    }
}


// ---- Event Handlers ----

// Handle saving the temporary file
async function handlePreviewSave(document: vscode.TextDocument): Promise<void> {
	// Check if the saved document is one of our temporary files by looking in the map
    const uriString = document.uri.toString();
    const mapping = tempFileToOriginMap.get(uriString);
	if (!mapping) {
		// This save event is for a different file, ignore it
		return;
	}

    // Check if this is a temporary file from the current window
    if (mapping.windowId !== currentWindowId) {
        console.log(`[${currentWindowId}] Ignoring temporary file save from another window(${mapping.windowId.substring(0, 8)}...): ${uriString}`);
        return;
    }

    console.log(`[${currentWindowId}] Handling temporary file save: ${uriString}`);
	const { originalPath, lineIndex } = mapping;
	const editedContent = document.getText();

	// Validate JSON before saving
	let parsedJson;
	try {
		parsedJson = JSON.parse(editedContent); // Check if it's valid JSON
	} catch (e: any) {
		vscode.window.showErrorMessage(`Invalid JSON: ${e.message}. Please correct before saving.`);
		return; // Stop saving if JSON is invalid
	}

	// Format the JSON string into a single line before saving
	const singleLineJson = JSON.stringify(parsedJson);

	try {
		await writeFileAtLine(originalPath, lineIndex, singleLineJson);
        // Provide feedback in status bar
        vscode.window.setStatusBarMessage(`✅ Saved line ${lineIndex} to ${path.basename(originalPath)}`, 5000);

	} catch (error: any) {
		console.error(`[${currentWindowId}] Error calling writeFileAtLine for save:`, error);
		// Error message is shown within writeFileAtLine
	}
}


// This method is called when your extension is deactivated
export async function deactivate() {
    // Log current window info for debugging
    console.log(`[${currentWindowId}] JSONL Viewer deactivating, cleaning up resources...`);
    
    try {
        // 1. Clean up temporary files for the current window
        // First check if temporary directory exists
        if (!currentTempDir) {
            console.log(`[${currentWindowId}] No temporary directory to clean up`);
            return;
        }
        
        // Check if temporary directory exists
        try {
            await fs.promises.access(currentTempDir);
            
            // List all temporary files
            const files = await fs.promises.readdir(currentTempDir);
            console.log(`[${currentWindowId}] Found ${files.length} temporary files to clean up`);
            
            // Delete each temporary file
            for (const file of files) {
                try {
                    const filePath = path.join(currentTempDir, file);
                    // Ensure we only delete files, not directories
                    const stats = await fs.promises.stat(filePath);
                    if (stats.isFile()) {
                        await fs.promises.unlink(filePath);
                        console.log(`[${currentWindowId}] Deleted temporary file: ${file}`);
                    }
                } catch (fileError) {
                    console.error(`[${currentWindowId}] Failed to delete temporary file: ${file}`, fileError);
                }
            }
            
            // Try to delete the temporary directory
            try {
                const remainingFiles = await fs.promises.readdir(currentTempDir);
                if (remainingFiles.length === 0) {
                    await fs.promises.rmdir(currentTempDir);
                    console.log(`[${currentWindowId}] Successfully deleted temporary directory: ${currentTempDir}`);
                } else {
                    console.log(`[${currentWindowId}] Temporary directory not empty, skipping deletion: ${currentTempDir}`);
                }
            } catch (rmDirError) {
                console.error(`[${currentWindowId}] Failed to delete temporary directory:`, rmDirError);
            }
        } catch (error) {
            // Directory doesn't exist, which is normal
            console.log(`[${currentWindowId}] Temporary directory does not exist, no cleanup needed: ${currentTempDir}`);
        }
        
        // 2. Clean up mappings for the current window from workspace state
        const storedMap = globalContext.workspaceState.get<Record<string, TempFileMapping>>(TEMP_MAP_STORAGE_KEY) || {};
        let cleanedCount = 0;
        
        // Remove all mappings for the current window
        Object.keys(storedMap).forEach(key => {
            if (storedMap[key].windowId === currentWindowId) {
                delete storedMap[key];
                cleanedCount++;
            }
        });
        
        // Save updated mappings back to workspace state
        if (cleanedCount > 0) {
            await globalContext.workspaceState.update(TEMP_MAP_STORAGE_KEY, storedMap);
            console.log(`[${currentWindowId}] Removed ${cleanedCount} mappings from workspace state`);
        }
        
        // 3. Clear mappings from memory
        tempFileToOriginMap.clear();
        console.log(`[${currentWindowId}] Cleared temporary file mappings from memory`);
        console.log(`[${currentWindowId}] JSONL Viewer deactivation complete`);
    } catch (error) {
        console.error(`[${currentWindowId}] Error during deactivation:`, error);
    }
}
