# Lumina Finanças

Aplicativo pessoal para registrar receitas e gastos com o mínimo de atrito. Os dados ficam no próprio dispositivo, em `localStorage`; não há conta nem sincronização externa.

## Rodar no navegador

```bash
npm install
npm run dev
```

Abra `http://localhost:1420`. Pressione `N` em qualquer lugar do painel para registrar uma nova movimentação.

## Rodar como aplicativo desktop

Com os [pré-requisitos do Tauri 2](https://v2.tauri.app/start/prerequisites/) instalados:

```bash
npm run tauri dev
```

## Verificações

```bash
npm test
npm run build
```

O projeto usa React, TypeScript, Recharts e Tauri 2.
