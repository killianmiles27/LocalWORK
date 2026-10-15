# Installs the web tool libraries for the workbench MCP server into workbench-mcp\libs (self-contained, does not touch the model environment).
param([string]$Python = "C:\Random\Working Folder\LocalWORK\strata\.venv\Scripts\python.exe",
      [string]$Dest = "$PSScriptRoot\..\workbench-mcp\libs")
& $Python -m pip install -q --target $Dest ddgs httpx beautifulsoup4 markdownify pypdf
