$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$cueExe = Join-Path $taskRoot 'src-tauri\target\debug\cue.exe'
$env:CUEREVIEW_DATA_DIR = Join-Path $taskRoot '.local\pipeline-data'
$env:CUEREVIEW_MODEL = Join-Path $env:LOCALAPPDATA 'CueReview\models\ggml-base.bin'
$env:PATH = (Join-Path $env:LOCALAPPDATA 'CueReview\tools\whisper-b5454') + ';' + $env:PATH
$projectId = [guid]::NewGuid().ToString()
$sessionId = [guid]::NewGuid().ToString()
$projectDir = Join-Path $env:CUEREVIEW_DATA_DIR 'projects'
$sessionDir = Join-Path $env:CUEREVIEW_DATA_DIR "sessions\$sessionId"
New-Item -ItemType Directory -Force -Path $projectDir,$sessionDir | Out-Null
$created = [DateTimeOffset]::UtcNow.ToString('o')
@{id=$projectId;name='Speech pipeline verification';createdAt=$created} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $projectDir "$projectId.json")
Add-Type -AssemblyName System.Speech
$speech = New-Object System.Speech.Synthesis.SpeechSynthesizer
$speech.SetOutputToWaveFile((Join-Path $sessionDir 'mic.wav'))
$speech.Speak('When I open the library, the transition feels slow. When I click here, the details panel does not update. Move this button to the top toolbar.')
$speech.Dispose()
$seconds = [double](& ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 (Join-Path $sessionDir 'mic.wav'))
& ffmpeg -hide_banner -loglevel error -y -stream_loop -1 -i (Join-Path $taskRoot 'test-results\native-capture\window\video.mp4') -i (Join-Path $sessionDir 'mic.wav') -map 0:v:0 -map 1:a:0 -t $seconds -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -movflags +faststart (Join-Path $sessionDir 'video.mp4')
if ($LASTEXITCODE -ne 0) { throw 'Fixture media creation failed' }
@{id=$sessionId;projectId=$projectId;name='Known speech over real captured window';createdAt=$created;durationMs=[long]($seconds*1000);status='error';videoPath=$null;folderPath=$sessionDir;error='Test fixture awaiting transcription';sourceId='fixture:captured-window';microphoneId='fixture:local-speech';systemAudio=$false} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $sessionDir 'session.json')
& $cueExe transcribe $sessionId | Set-Content -LiteralPath (Join-Path $sessionDir 'cli-transcript.json')
if ($LASTEXITCODE -ne 0) { throw 'Local transcription failed' }
$matches = (& $cueExe find $sessionId --phrase 'click here') | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or @($matches).Count -lt 1) { throw 'Expected phrase not found in timestamped transcript' }
$frame = (& $cueExe frame $sessionId --phrase 'here' --occurrence 1) | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $frame.path)) { throw 'Phrase frame retrieval failed' }
$clip = (& $cueExe clip $sessionId --start-ms $matches[0].startMs --end-ms ($matches[0].endMs + 1000)) | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $clip.path)) { throw 'Clip retrieval failed' }
& ffmpeg -hide_banner -loglevel error -i $clip.path -f null -
if ($LASTEXITCODE -ne 0) { throw 'Exported clip failed full decode' }
$info = (& $cueExe info $sessionId) | ConvertFrom-Json
if ($info.status -ne 'ready' -or !$info.videoPath) { throw 'Successful transcription did not restore usable session metadata' }
$result = @{sessionId=$sessionId;durationMs=$info.durationMs;phrase=$matches;frame=$frame.path;clip=$clip.path;status='passed';fixture='Local Windows speech synthesis over a real captured window, separate from hardware microphone tests'}
$json = $result | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText((Join-Path $taskRoot 'test-results\pipeline-verification.json'), $json, (New-Object Text.UTF8Encoding($false)))
Write-Output $json
