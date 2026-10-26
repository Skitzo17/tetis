// Ponte com o Firebase: login (Authentication) e dados de cada conta (Firestore).
// Só é carregado quando config.js tem o FIREBASE_CONFIG preenchido.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendPasswordResetEmail, GoogleAuthProvider, signInWithPopup, signOut, updateProfile,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, writeBatch, query, where, orderBy, limit, getDocs, getDoc,
  setDoc, addDoc, updateDoc, deleteDoc, arrayUnion, arrayRemove, increment, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const app = initializeApp(window.FIREBASE_CONFIG);
const auth = getAuth(app);
auth.languageCode = 'pt-BR';
// Cache no aparelho: funciona offline e envia o que ficou pendente quando a internet voltar
const db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

// Cada conta só enxerga usuarios/{uid}/partes/* (garantido pelas regras do Firestore)
const partes = (uid) => collection(db, 'usuarios', uid, 'partes');

let pararEscuta = null;

// ---------- Grupos: ranking e feed compartilhados só entre os membros ----------
// grupos/{codigo}: { nome, criador, membros[uid], criado }   (o id do grupo é o código de convite)
// grupos/{g}/membros/{uid}: { nome, avatar, dias[] }        (o que aparece no ranking)
// grupos/{g}/posts/{id}: { uid, nome, avatar, foto, legenda, curtidas[], nComentarios, criado }
// grupos/{g}/posts/{id}/comentarios/{id}: { uid, nome, avatar, texto, criado }
const LETRAS_CODIGO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O e 1/I, para não confundir
const novoCodigo = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (n) => LETRAS_CODIGO[n % 32]).join('');

function criarSocial() {
  const grupos = collection(db, 'grupos');
  const membros = (g) => collection(db, 'grupos', g, 'membros');
  const posts = (g) => collection(db, 'grupos', g, 'posts');
  const comentarios = (g, p) => collection(db, 'grupos', g, 'posts', p, 'comentarios');
  const eu = () => auth.currentUser.uid;
  const comData = (d) => {
    const dados = d.data({ serverTimestamps: 'estimate' });
    return { id: d.id, ...dados, criado: dados.criado?.toMillis?.() ?? Date.now() };
  };

  async function apagarPost(g, p) {
    const cs = await getDocs(comentarios(g, p));
    await Promise.all(cs.docs.map((c) => deleteDoc(c.ref)));
    await deleteDoc(doc(posts(g), p));
  }

  return {
    ouvirGrupos: (aoMudar, aoErro) => onSnapshot(query(grupos, where('membros', 'array-contains', eu())),
      (s) => aoMudar(s.docs.map((d) => ({ id: d.id, ...d.data() }))), aoErro),
    ouvirGrupo(g, aoMembros, aoPosts, aoErro) {
      const a = onSnapshot(membros(g), (s) => aoMembros(s.docs.map((d) => ({ uid: d.id, ...d.data() }))), aoErro);
      const b = onSnapshot(query(posts(g), orderBy('criado', 'desc'), limit(40)), (s) => aoPosts(s.docs.map(comData)), aoErro);
      return () => { a(); b(); };
    },
    async criarGrupo(nome) {
      for (let tentativa = 0; ; tentativa++) {
        const id = novoCodigo();
        try {
          await setDoc(doc(grupos, id), { nome, criador: eu(), membros: [eu()], criado: serverTimestamp() });
          return id;
        } catch (e) {
          if (tentativa >= 2) throw e; // código já existia (raríssimo): tenta outro
        }
      }
    },
    async verGrupo(id) {
      const d = await getDoc(doc(grupos, id));
      return d.exists() ? { id, ...d.data() } : null;
    },
    entrarGrupo: (id) => updateDoc(doc(grupos, id), { membros: arrayUnion(eu()) }),
    // Sai do grupo apagando os próprios posts e a entrada no ranking; o último a sair apaga o grupo
    async sairGrupo(id) {
      const meus = await getDocs(query(posts(id), where('uid', '==', eu())));
      for (const p of meus.docs) await apagarPost(id, p.id);
      await deleteDoc(doc(membros(id), eu()));
      const g = await getDoc(doc(grupos, id));
      if (g.exists() && g.data().membros.length <= 1) await deleteDoc(g.ref);
      else await updateDoc(doc(grupos, id), { membros: arrayRemove(eu()) });
    },
    publicar: (g, dados) => setDoc(doc(membros(g), eu()), { ...dados, atualizado: serverTimestamp() }),
    // O mesmo post vai para todos os grupos da pessoa de uma vez
    async postar(gs, dados) {
      const lote = writeBatch(db);
      for (const g of gs) lote.set(doc(posts(g)), { ...dados, uid: eu(), curtidas: [], nComentarios: 0, criado: serverTimestamp() });
      await lote.commit();
    },
    apagarPost,
    curtir: (g, p, sim) => updateDoc(doc(posts(g), p), { curtidas: sim ? arrayUnion(eu()) : arrayRemove(eu()) }),
    comentarios: async (g, p) => (await getDocs(query(comentarios(g, p), orderBy('criado')))).docs.map(comData),
    async comentar(g, p, dados) {
      await addDoc(comentarios(g, p), { ...dados, uid: eu(), criado: serverTimestamp() });
      await updateDoc(doc(posts(g), p), { nComentarios: increment(1) });
    },
    async apagarComentario(g, p, id) {
      await deleteDoc(doc(comentarios(g, p), id));
      await updateDoc(doc(posts(g), p), { nComentarios: increment(-1) });
    },
  };
}

onAuthStateChanged(auth, (user) => {
  pararEscuta?.();
  pararEscuta = null;
  if (!user) {
    window.Slancio.semUsuario();
    return;
  }
  // foto: a do Google, usada enquanto a pessoa não escolher outra no perfil
  window.Slancio.comUsuario({ uid: user.uid, email: user.email, nome: user.displayName || '', foto: user.photoURL || '' });
  pararEscuta = onSnapshot(partes(user.uid), { includeMetadataChanges: true }, (snap) => {
    const dados = {};
    snap.forEach((d) => { dados[d.id] = d.data().json; });
    window.Slancio.recebeuNuvem(dados, { doCache: snap.metadata.fromCache, pendente: snap.metadata.hasPendingWrites });
  }, (erro) => window.Slancio.erroNuvem(erro));
});

window.Nuvem = {
  entrar: (email, senha) => signInWithEmailAndPassword(auth, email, senha),
  async criarConta(nome, email, senha) {
    const cred = await createUserWithEmailAndPassword(auth, email, senha);
    if (nome) {
      await updateProfile(cred.user, { displayName: nome });
      window.Slancio.atualizarNome(nome);
    }
  },
  google: () => signInWithPopup(auth, new GoogleAuthProvider()),
  recuperarSenha: (email) => sendPasswordResetEmail(auth, email),
  sair: () => signOut(auth),
  atualizarNome: (nome) => updateProfile(auth.currentUser, { displayName: nome }),
  social: criarSocial(),
  // alteradas: id -> JSON; removidas: ids
  async enviar(uid, alteradas, removidas) {
    const lote = writeBatch(db);
    for (const [id, json] of Object.entries(alteradas)) lote.set(doc(partes(uid), id), { json, atualizado: Date.now() });
    for (const id of removidas) lote.delete(doc(partes(uid), id));
    await lote.commit();
  },
};
