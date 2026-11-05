; Let the phone reach Wasl on the local network without a firewall prompt.
!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Wasl"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="Wasl" dir=in action=allow program="$INSTDIR\Wasl.exe" enable=yes profile=any protocol=TCP localport=47800'
  nsExec::Exec 'netsh advfirewall firewall add rule name="Wasl" dir=in action=allow program="$INSTDIR\Wasl.exe" enable=yes profile=any protocol=UDP localport=47801'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Wasl"'
!macroend
