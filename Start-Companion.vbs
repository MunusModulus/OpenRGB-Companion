Option Explicit

Dim shell, fso, projectDir, scriptPath, commandLine
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

projectDir = fso.GetParentFolderName(WScript.ScriptFullName)
scriptPath = fso.BuildPath(projectDir, "Start-Dev.ps1")
commandLine = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & scriptPath & """"

' Window style 0 keeps the development host hidden while the Tauri GUI remains visible.
shell.Run commandLine, 0, False
