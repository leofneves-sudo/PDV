Option Explicit
Dim shell, files, project, nodePath, scriptPath, result, command
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
project = files.GetParentFolderName(files.GetParentFolderName(WScript.ScriptFullName))
scriptPath = files.BuildPath(project, "scripts\start-pdv.cjs")
nodePath = files.BuildPath(shell.ExpandEnvironmentStrings("%ProgramFiles%"), "nodejs\node.exe")
If WScript.Arguments.Count > 0 Then nodePath = WScript.Arguments(0)
If Not files.FileExists(nodePath) Then
  MsgBox "Node.js nao encontrado. Instale o Node.js 24 ou mais recente.", 16, "Last Place PDV"
  WScript.Quit 1
End If
shell.CurrentDirectory = project
command = Chr(34) & nodePath & Chr(34) & " " & Chr(34) & scriptPath & Chr(34)
On Error Resume Next
result = shell.Run(command, 0, True)
If Err.Number <> 0 Then
  MsgBox "Nao foi possivel iniciar o Last Place PDV: " & Err.Description, 16, "Last Place PDV"
  WScript.Quit 1
End If
On Error GoTo 0
If result <> 0 Then
  MsgBox "Nao foi possivel iniciar os dois servidores. Consulte os detalhes em:" & vbCrLf & files.BuildPath(project, "data\inicializador\ultimo-erro.txt"), 16, "Last Place PDV"
End If
WScript.Quit result
