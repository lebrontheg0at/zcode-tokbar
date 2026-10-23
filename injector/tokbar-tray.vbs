Set fso = CreateObject("Scripting.FileSystemObject")
p = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & p & "\tokbar-tray.ps1""", 0, False
