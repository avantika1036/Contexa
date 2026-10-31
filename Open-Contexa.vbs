' Everyday launcher after the one-time setup script has installed dependencies and built the UI.
' Starts Electron silently; Contexa opens as a normal Windows desktop window and manages its own tray.
Option Explicit
Dim shell, fso, root, desktop
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
desktop = fso.BuildPath(root, "desktop")
shell.CurrentDirectory = desktop
shell.Run "cmd.exe /d /c npm start", 0, False
