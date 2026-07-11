' Starts the vel'OH collector in a hidden window, looping every 60 s.
' Safe to run repeatedly: exits if a collector is already running.
' A copy of the launcher in shell:startup invokes this at every logon.

Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set procs = wmi.ExecQuery( _
  "SELECT ProcessId FROM Win32_Process WHERE Name='node.exe' AND CommandLine LIKE '%collect.mjs%'")
If procs.Count > 0 Then WScript.Quit

Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "C:\Users\peter\OneDrive\dev\veloh"
sh.Run """C:\Users\peter\AppData\Local\node-portable\node-v24.18.0-win-x64\node.exe"" collector\collect.mjs --loop 60 --tag local", 0, False
