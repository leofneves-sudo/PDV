#!/bin/bash

fail() {
  printf '%s\n' "$1" >&2
  if [ -t 0 ]; then
    read -r -p "Pressione Enter para fechar..." resposta
  fi
  exit 1
}

node_supported() {
  [ -x "$1" ] && "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' >/dev/null 2>&1
}

cd -- "$(dirname -- "$0")" || fail "Não foi possível abrir a pasta do PDV."
[ -f scripts/start-pdv.cjs ] || fail "Mantenha este arquivo na pasta do projeto, junto com a pasta scripts."

# O Terminal aberto pelo Finder pode receber um PATH diferente do terminal habitual.
node_path=
for candidate in "$(command -v node)" /opt/homebrew/bin/node /usr/local/bin/node /opt/local/bin/node; do
  if node_supported "$candidate"; then
    node_path="$candidate"
    break
  fi
done

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -z "$node_path" ] && [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh" --no-use
  if nvm use --silent node >/dev/null 2>&1; then
    node_path="$(command -v node)"
  fi
fi
node_supported "$node_path" || fail "Node.js 24 ou mais recente não encontrado. Instale o Node.js e tente novamente."

if ! "$node_path" scripts/start-pdv.cjs; then
  fail "Consulte os detalhes em ${PDV_START_DIR:-data/inicializador}/ultimo-erro.txt."
fi
