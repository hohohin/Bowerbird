Option Explicit

Dim files, shell, entry
Set files = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = files.GetParentFolderName(WScript.ScriptFullName)

If WScript.Arguments.Count = 1 Then
  If WScript.Arguments(0) = "--open-window" Then OpenConsoleWindow
ElseIf WScript.Arguments.Count = 0 Then
  entry = files.BuildPath(shell.CurrentDirectory, "apps\code-reader-mcp\mini-window.ps1")
  If Not shell.AppActivate("Bowerbird MCP Mini") Then
    shell.Run "powershell.exe -NoProfile -NonInteractive -Sta -ExecutionPolicy Bypass -File " & Quoted(entry), 0, False
  End If
End If

Function Quoted(value)
  Quoted = Chr(34) & value & Chr(34)
End Function

Sub OpenConsoleWindow
  Const address = "http://127.0.0.1:48733"
  Dim relative, folder, base, executable
  For Each relative In Array("Microsoft\Edge\Application\msedge.exe", "Google\Chrome\Application\chrome.exe")
    For Each folder In Array("%ProgramFiles(x86)%", "%ProgramFiles%", "%LOCALAPPDATA%")
      base = shell.ExpandEnvironmentStrings(folder)
      executable = files.BuildPath(base, relative)
      If files.FileExists(executable) Then
        shell.Run Quoted(executable) & " --app=" & address & " --window-size=960,800", 1, False
        Exit Sub
      End If
    Next
  Next
  shell.Run address, 1, False
End Sub
