' Windows logon shim: boots the Ubuntu WSL distro and starts the vel'OH
' collector inside it (collector/run-local.sh — single-instance via flock).
' WSL does not start by itself at Windows logon, hence this launcher.
' Install: copy this file into the folder that opens with  shell:startup
Set sh = CreateObject("WScript.Shell")
sh.Run "wsl.exe -d Ubuntu -u chillin -- /home/chillin/dev/veloh/collector/run-local.sh", 0, False
