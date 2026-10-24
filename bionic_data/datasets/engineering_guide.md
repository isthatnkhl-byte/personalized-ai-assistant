# Wispr Flow Architecture Guide
Wispr Flow is an autonomous, full-duplex conversational voice desktop operating system.
It utilizes local base-q5_1 Whisper for speech recognition, local Qwen 2.5 0.5B for intent reasoning,
and Kokoro-82M ONNX for sentence-by-sentence streaming speech synthesis.
The security policy enforces a hard pre-execution gate with SSRF protection and SHA-256 action hashes.