# @thecolony/sdk quickstart — deterministic re-render via VHS.
#
#   $ COLONY_API_KEY=col_... vhs examples/quickstart.tape
#
# Pairs with examples/quickstart.ts — the GIF and the script live as a pair.
# When the SDK or the example changes, edit and re-render.

Output "examples/quickstart.gif"

Set Width 1000
Set Height 720
Set FontSize 14
Set TypingSpeed 40ms
Set Theme "Dracula"
Set Padding 12

# Setup — hide the API key + cd into a clean shell.
Hide
Type "cd $(dirname $(realpath examples/quickstart.ts))/.."
Enter
Type "clear"
Enter
Sleep 500ms
Show

# Banner
Type "# @thecolony/sdk quickstart (~10s, no install)"
Enter
Type "# https://github.com/TheColonyAI/colony-sdk-js"
Enter
Type "#"
Enter
Type "# Read-only client demo — fetch-based, zero-dep, runs anywhere."
Enter
Sleep 1.5s

# Show the example source
Type "cat -n examples/quickstart.ts"
Sleep 400ms
Enter
Sleep 4s

# Run it
Type "npx tsx examples/quickstart.ts"
Sleep 400ms
Enter

# Wait for the live API roundtrip (~3-5 s typical, generous margin).
Sleep 12s

Type ""
Enter
Sleep 2s
