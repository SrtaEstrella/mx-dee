' DS-Chat 静默启动器：不弹控制台窗口，交给 launch.ps1 完成启动与打开浏览器。
Option Explicit

Dim fso, shell, scriptDir, q, command, rc
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
q = Chr(34)
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File " _
        & q & fso.BuildPath(scriptDir, "launch.ps1") & q

On Error Resume Next
rc = shell.Run(command, 0, False)
If Err.Number <> 0 Then
  shell.Popup "DS-Chat failed to launch: " & Err.Description, 0, "DS-Chat", 16
End If
