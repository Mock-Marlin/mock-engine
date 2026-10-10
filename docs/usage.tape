# Record from packages/mock-engine with mock-engine on PATH and port 4080 free.
# Needs ttyd, ffmpeg, and Chrome (VHS downloads a browser on first run):
#   mkdir -p /tmp/mock-engine-gif-demo && rm -f /tmp/mock-engine-gif-demo/mock-engine.yaml /tmp/mock-engine-gif-demo/server.log
#   vhs docs/usage.tape
# The gif in this directory is that session. If Chrome will not start, render an asciicast of the same commands with agg.
Output docs/usage.gif
Set Shell bash
Set Width 1100
Set Height 680
Set FontSize 16
Set FontFamily "DejaVu Sans Mono"
Set Padding 24
Set TypingSpeed 45ms

Hide
Type "cd /tmp/mock-engine-gif-demo" Enter
Type "set -m" Enter
Show

Type "mock-engine init" Sleep 300ms Enter
Sleep 900ms

Type "mock-engine check" Sleep 200ms Enter
Sleep 1200ms

Type "MOCK_PLAIN=1 mock-engine >server.log 2>&1 &" Sleep 200ms Enter
Sleep 2s

Type "curl -s http://127.0.0.1:4080/s/default/health" Sleep 200ms Enter
Sleep 1200ms

Type "echo && head -n 16 server.log" Sleep 200ms Enter
Sleep 2s

Hide
Type "kill %1" Enter
Sleep 400ms
