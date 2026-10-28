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
       // Tudo o que vai para os grupos é lido por outras pessoas: formato e tamanho são conferidos aqui
       function codigoOk(g) { return g.matches('^[A-HJ-NP-Z2-9]{6}$'); }
       function idOk(id) { return id.matches('^[A-Za-z0-9]{20}$'); }
       function texto(v, max) { return v is string && v.size() <= max; }
       // Imagem embutida: confere o cabeçalho com split (uma regex sobre ~1 MB de base64 pode estourar o limite das regras)
       function imagem(v, max) { return v is string && v.size() <= max
                                   && v.split(',')[0] in ['data:image/jpeg;base64', 'data:image/png;base64', 'data:image/webp;base64']; }
       function avatar(v) { return v == '' || imagem(v, 60000)
                            || (texto(v, 2000) && v.matches('^https://lh[0-9][.]googleusercontent[.]com/.+')); }
       function novo() { return request.resource.data; }
       function mudou() { return request.resource.data.diff(resource.data).affectedKeys(); }

       // Dados privados: cada pessoa só lê e grava os próprios, e só nas partes que o app usa
       // (base, perfil, sessoes-AAAA, transacoes-AAAA), com até ~1 MB cada
       match /usuarios/{uid}/partes/{id} {
         allow read, delete: if logado() && eu() == uid;
         allow create, update: if logado() && eu() == uid
           && id.matches('^(base|perfil|(sessoes|transacoes)-[0-9]{4})$')
           && novo().keys().hasOnly(['json', 'atualizado']) && novo().json is string && novo().json.size() < 1000000;
       }

       // Grupos (o id é o código de convite, 6 letras/números)
       match /grupos/{g} {
         allow get: if logado() && codigoOk(g);                   // ver o nome antes de entrar, com o código
         allow list: if logado() && eu() in resource.data.membros; // listar só os meus grupos
         allow create: if logado() && codigoOk(g)
           && novo().keys().hasOnly(['nome', 'criador', 'membros', 'criado'])
           && texto(novo().nome, 40) && novo().nome.size() > 0
           && novo().criador == eu() && novo().membros == [eu()] && novo().criado == request.time;
         // Alterar só a lista de membros, e só para entrar ou sair a si mesmo
         allow update: if logado()
           && mudou().hasOnly(['membros']) && novo().membros.size() <= 50
           && (novo().membros.toSet() == resource.data.membros.toSet().union([eu()].toSet())
               || novo().membros.toSet() == resource.data.membros.toSet().difference([eu()].toSet()));
         allow delete: if logado() && (resource.data.criador == eu() || resource.data.membros == [eu()]);

         // Ranking: cada membro grava só a própria entrada, com campos e tamanhos limitados
         match /membros/{uid} {
           allow read: if membro(g);
           allow create, update: if membro(g) && eu() == uid
             && novo().keys().hasOnly(['nome', 'avatar', 'dias', 'atualizado'])
             && texto(novo().nome, 60) && avatar(novo().avatar)
             && novo().dias is list && novo().dias.size() <= 800
             && novo().atualizado == request.time;
           allow delete: if logado() && eu() == uid;
         }

         // Feed
         match /posts/{p} {
           allow read: if membro(g);
           allow create: if membro(g) && idOk(p)
             && novo().keys().hasOnly(['uid', 'nome', 'avatar', 'foto', 'legenda', 'curtidas', 'nComentarios', 'criado'])
             && novo().uid == eu() && texto(novo().nome, 60) && avatar(novo().avatar)
             && imagem(novo().foto, 950000) && texto(novo().legenda, 300)
             && novo().curtidas == [] && novo().nComentarios == 0 && novo().criado == request.time;
           // Curtir/descurtir: só o próprio uid entra ou sai da lista. Comentários: o contador anda de 1 em 1
           allow update: if membro(g) && (
             (mudou().hasOnly(['curtidas']) && novo().curtidas.size() <= 200
               && novo().curtidas.size() == novo().curtidas.toSet().size()
               && (novo().curtidas.toSet() == resource.data.curtidas.toSet().union([eu()].toSet())
                   || novo().curtidas.toSet() == resource.data.curtidas.toSet().difference([eu()].toSet())))
             || (mudou().hasOnly(['nComentarios'])
               && (novo().nComentarios == resource.data.nComentarios + 1
                   || (novo().nComentarios == resource.data.nComentarios - 1 && novo().nComentarios >= 0))));
           allow delete: if logado() && (resource.data.uid == eu() || grupo(g).criador == eu());

           match /comentarios/{c} {
             allow read: if membro(g);
             allow create: if membro(g) && idOk(c)
               && novo().keys().hasOnly(['uid', 'nome', 'avatar', 'texto', 'criado'])
               && novo().uid == eu() && texto(novo().nome, 60) && avatar(novo().avatar)
               && texto(novo().texto, 300) && novo().texto.size() > 0 && novo().criado == request.time;
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
feitas em um aparecem no outro. Se os dois aparelhos mexerem na mesma parte ao mesmo tempo, o app junta as duas versões:
treinos e lançamentos item a item, e a parte `base` campo a campo (se o mesmo item foi editado nos dois, vale o do aparelho que juntou).

O **Client Secret da Pluggy não vai para a nuvem**: fica só no aparelho onde foi digitado (`localStorage`, chave `tetis-pluggy:{uid}`).

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

Os lançamentos entram de três formas:
- **Manual**, pelo botão "+ Lançamento".
- **Importando o extrato** em OFX/CSV.
- **Automaticamente pelo Open Finance**, com o **Meu Pluggy** (`openfinance.js`).

Em todos os casos, os lançamentos repetidos são ignorados, a categoria é sugerida e o app aprende quando você corrige uma.

### Open Finance (Meu Pluggy, grátis)

Cada pessoa usa a **própria** conta Pluggy, no plano pessoal e gratuito, que aceita até 5 bancos do mesmo CPF.
O Client ID e os Item IDs ficam nos dados da pessoa (`usuarios/{uid}`, protegido pelas regras do Firestore).
O **Client Secret fica só no aparelho** onde foi digitado: não vai para a nuvem nem para o backup. O app fala direto com `https://api.pluggy.ai`, que aceita chamadas do navegador, sem servidor.

O passo a passo também aparece dentro do app, em Finanças → "Conectar meus bancos":
1. Em **meu.pluggy.ai**, crie a conta e conecte os bancos e cartões. A autorização é feita no app do banco.
2. Em **dashboard.pluggy.ai**, crie **uma aplicação**, ative o conector **"MeuPluggy"** e vincule os bancos.
3. Copie o **Client ID** e o **Client Secret** para o Tétis. O secret aparece só quando a aplicação é criada.
4. No Tétis, toque em **"Conectar banco pelo Meu Pluggy"**. Abre a janela oficial da Pluggy (Pluggy Connect, conector 200 = MeuPluggy),
   você escolhe o banco e o **Item ID é preenchido sozinho**. Também dá para colar um Item ID manualmente.

Como a sincronização funciona:
- Na primeira vez, busca os **últimos 12 meses**. Depois, desde a última sincronização, com folga de 10 dias.
- Sincroniza sozinha ao abrir Finanças, se a última vez foi há mais de 12 h. A Pluggy atualiza uma vez por dia.
- Endpoints: `POST /auth` → `GET /items/{id}` → `GET /accounts?itemId=` → `GET /v2/transactions` (cursor `next`).
  Se a v2 falhar, usa `/transactions` paginado.
- Conta corrente: débito vem negativo. Cartão: a compra vem positiva e vira despesa; o estorno vira reembolso.
- **Ficam de fora**, para não contar em dobro: lançamentos pendentes, pagamentos de fatura e transferências entre as próprias contas.
- Identificador anti-repetição: `p:{id da transação na Pluggy}`.

O plano pessoal não permite usar uma única conta Pluggy para os dados de outras pessoas. Para isso, só o plano comercial,
a partir de R$ 2.500/mês.