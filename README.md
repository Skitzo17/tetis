# Tétis — PWA

Tétis é um app pessoal com treino, peso, notas e finanças. Funciona offline.

Ele roda de dois jeitos:
- **Sem contas** (`config.js` com `FIREBASE_CONFIG = null`): os dados ficam só no aparelho.
- **Com contas** (Firebase): cada pessoa entra com e-mail/senha ou com o Google. Os dados ficam na conta dela, aparecem em
  qualquer aparelho e continuam funcionando offline (sincronizam quando a internet volta).

## Rodar no computador

```bash
python -m http.server 5180 --directory "PWA Pessoal"
```

Depois, abra http://localhost:5180.

## Ativar as contas (Firebase, grátis)

1. Acesse **console.firebase.google.com** → *Criar projeto* (o Google Analytics pode ficar desligado).
2. **Authentication** → *Começar* → aba *Sign-in method*: ative **E-mail/senha** e **Google**.
3. **Firestore Database** → *Criar banco de dados* → modo **produção** → local **southamerica-east1 (São Paulo)**.
4. Ainda no Firestore, aba **Regras**: apague o conteúdo e cole as regras abaixo. Depois clique em *Publicar*.

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       function logado() { return request.auth != null; }
       function eu() { return request.auth.uid; }
       function grupo(g) { return get(/databases/$(database)/documents/grupos/$(g)).data; }
       function membro(g) { return logado() && eu() in grupo(g).membros; }

       // Dados privados: cada pessoa só lê e grava os próprios
       match /usuarios/{uid}/{documento=**} {
         allow read, write: if logado() && eu() == uid;
       }

       // Grupos (o id é o código de convite)
       match /grupos/{g} {
         allow get: if logado();                                  // ver o nome antes de entrar, com o código
         allow list: if logado() && eu() in resource.data.membros; // listar só os meus grupos
         allow create: if logado() && request.resource.data.criador == eu()
                       && request.resource.data.membros == [eu()];
         // Alterar só a lista de membros, e só para entrar ou sair a si mesmo
         allow update: if logado()
           && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['membros'])
           && (request.resource.data.membros.toSet() == resource.data.membros.toSet().union([eu()].toSet())
               || request.resource.data.membros.toSet() == resource.data.membros.toSet().difference([eu()].toSet()));
         allow delete: if logado() && (resource.data.criador == eu() || resource.data.membros == [eu()]);

         // Ranking: cada membro grava só a própria entrada
         match /membros/{uid} {
           allow read: if membro(g);
           allow create, update: if membro(g) && eu() == uid;
           allow delete: if logado() && eu() == uid;
         }

         // Feed
         match /posts/{p} {
           allow read: if membro(g);
           allow create: if membro(g) && request.resource.data.uid == eu();
           allow update: if membro(g)
             && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['curtidas', 'nComentarios']);
           allow delete: if logado() && (resource.data.uid == eu() || grupo(g).criador == eu());

           match /comentarios/{c} {
             allow read: if membro(g);
             allow create: if membro(g) && request.resource.data.uid == eu();
             allow delete: if logado() && (resource.data.uid == eu()
               || get(/databases/$(database)/documents/grupos/$(g)/posts/$(p)).data.uid == eu()
               || grupo(g).criador == eu());
           }
         }
       }
     }
   }
   ```

5. **Configurações do projeto** (engrenagem) → *Seus apps* → ícone **Web `</>`** → registre o app (não precisa de Hosting).
   Copie o objeto `firebaseConfig` e cole em `config.js`, no lugar do `null`.
6. Quando publicar o app num endereço próprio (ex.: `meu-app.pages.dev`), adicione esse domínio em
   **Authentication → Settings → Authorized domains**. O `localhost` já vem liberado.

### Limitar quem pode usar (opcional)

Se ninguém mais puder criar conta, só as pessoas que você cadastrar conseguem entrar:
1. Cadastre cada pessoa em **Authentication → Users → Add user** (ou peça para ela criar a conta antes).
2. Em **Authentication → Settings → User actions**, desmarque **Enable create (sign-up)**.

Os dados de cada conta continuam separados de qualquer forma, por causa das regras do passo 4.

### Limites do plano grátis (Spark)

O Firestore permite 1 GB armazenado, 50 mil leituras e 20 mil gravações por dia, o que sobra para 10 pessoas.
O app só envia o que mudou, agrupado a cada ~1 segundo. O plano grátis não pausa por falta de uso e não pede cartão.

## Publicar (para usar no celular)

O app é publicado no **GitHub Pages**, automaticamente. Cada `git push` na branch `main` dispara o workflow
`.github/workflows/publicar.yml`, que copia os arquivos do app e publica em cerca de 1 minuto. O andamento aparece na aba **Actions** do repositório.

```bash
git add -A
git commit -m "Descrição da mudança"
git push
```

Quem já tem o app aberto ou instalado recebe a versão nova na próxima vez que abrir, porque o service worker
sempre busca primeiro a versão do servidor.

Se o endereço do site mudar, adicione o novo domínio em **Firebase → Authentication → Settings → Authorized domains**.
Para o GitHub Pages, o domínio é `seu-usuario.github.io`.

No celular, abra o endereço e use:
- Android/Chrome: menu ⋮ → *Instalar app*
- iPhone/Safari: Compartilhar → *Adicionar à Tela de Início*

## Arquivos

| Arquivo | O que é |
|---|---|
| `index.html` | Estrutura e navegação |
| `config.js` | Configuração do Firebase (ou `null` para usar sem contas) |
| `app.js` | Toda a lógica: telas, gráficos, importação de OFX/CSV, login e sincronização |
| `nuvem.js` | Ponte com o Firebase (login e Firestore); só carrega com as contas ativadas |
| `plano.js` | Plano de treino de exemplo (fichas A–E) e nota com as diretrizes |
| `styles.css` | Visual (tema claro/escuro automático) |
| `sw.js` | Service worker (cache offline) — ao mudar a lista de arquivos, troque `CACHE` |
| `manifest.webmanifest`, `icons/` | Metadados de instalação |

### Como os dados ficam no Firestore

`usuarios/{uid}/partes/{id}`. A parte `base` guarda a configuração, as fichas, o peso, as notas e os check-ins.
Os treinos registrados e os lançamentos ficam em partes separadas por ano (`sessoes-2026`, `transacoes-2026`),
para nenhum documento chegar ao limite de 1 MB. Quando a mesma conta é usada em dois aparelhos, as alterações
feitas em um aparecem no outro. Se as duas mexerem na mesma parte ao mesmo tempo, vale a última que chegou.

Na primeira vez que uma conta nova entra num aparelho que já tinha dados (de antes das contas),
esses dados são levados para a conta.

### Grupos (ranking e feed)

Em **Treino → Grupos**, qualquer pessoa pode criar um grupo e convidar outras pelo código (o id do grupo, com 6 letras e números).
Dá para participar de vários grupos. Quem não entra em nenhum continua com tudo privado.

- `grupos/{código}`: nome, criador e lista de membros.
- `grupos/{g}/membros/{uid}`: nome, miniatura da foto e dias de check-in. É isso que forma o ranking.
  Só contam os check-ins feitos **no próprio dia**, nunca os marcados depois no calendário.
- `grupos/{g}/posts/{id}` (+ `comentarios`): fotos do feed, curtidas e comentários.

Ao fazer check-in ou postar uma foto, a atualização vai para **todos os grupos** da pessoa (o post é copiado em cada um).
O criador do grupo pode apagar qualquer post. Quem sai de um grupo tem os próprios posts dele apagados,
e o último a sair apaga o grupo.

As fotos do feed são reduzidas no aparelho (até 1080 px, ~100 KB) e ficam no próprio Firestore. O Firebase Storage
exige o plano pago, por isso não é usado.

## Finanças e Open Finance

Hoje os dados entram de duas formas: pelo lançamento manual ou pela importação do extrato em **OFX/CSV**,
que o app do banco permite exportar. Os lançamentos repetidos são ignorados, a categoria é sugerida
automaticamente e o app aprende quando você corrige uma.

A integração automática exige um agregador de Open Finance (ex.: Pluggy). A chave de API não pode
ficar no navegador, então seria preciso um pequeno backend (ex.: uma função serverless) que busque as transações
e as entregue ao app.
