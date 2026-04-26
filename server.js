/* ======== process.env ======== */
require("dotenv").config();
/* ===================================================== */
/* ================= IMPORTS =========================== */
/* ===================================================== */
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const fetch = require("node-fetch"); // pour Imgbb
const nodemailer = require("nodemailer"); // pour email
const FormData = require("form-data");

/* ===================================================== */
/* ================= INITIALISATION ==================== */
/* ===================================================== */
const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 3000;

const multer = require("multer");

const path = require("path");
const fs = require("fs");

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = "./uploads"; // dossier temporaire
        if (!fs.existsSync(dir)) fs.mkdirSync(dir);
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `${Date.now()}-${Math.round(Math.random()*1e9)}${ext}`);
    }
});

// ================= CONFIG MULTER =================

const upload = multer({
    storage,
    limits: { fileSize: 20 * 1024 * 1024 }, // max 20MB par fichier
    fileFilter: (req, file, cb) => {
        if(file.mimetype.startsWith("image/")){
            cb(null, true);
        } else {
            cb(new Error("Seules les images sont autorisées"));
        }
    }
});

/* ===================================================== */
/* ================= FIREBASE ADMIN ==================== */
/* ===================================================== */
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

/* ===================================================== */
/* ==================== AUTH ========================== */
/* ===================================================== */

/* --- INSCRIPTION --- */
app.post("/api/register", async (req, res) => {
    const { nom, email, password, inscontact } = req.body;
    if (!nom || !email || !password || !inscontact) {
        return res.status(400).json({ message: "Tous les champs sont obligatoires" });
    }
    if (typeof inscontact !== "string" || inscontact.length < 5) {
        return res.status(400).json({ message: "Le contact est invalide" });
    }
    try {
        const userRecord = await admin.auth().createUser({ email });

        await admin.auth().updateUser(userRecord.uid, {
            password: password
        });
        await db.collection("users").doc(userRecord.uid).set({
            uid: userRecord.uid,
            nom,
            email,
            inscontact,
            createdAt: admin.firestore.Timestamp.now()
        });
        res.status(201).json({ message: "Utilisateur créé", uid: userRecord.uid });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
});

/* --- CONNEXION --- */
app.post("/api/login", async (req, res) => {
    const { email, password } = req.body;
    try {
        const apiKey = process.env.FIREBASE_API_KEY;
        const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`;
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password, returnSecureToken: true })
        });
        const data = await response.json();
        if (data.error) {
            let message = "Erreur de connexion";
            if (data.error.message === "EMAIL_NOT_FOUND") message = "Email introuvable";
            else if (data.error.message === "INVALID_PASSWORD") message = "Mot de passe incorrect";
            else if (data.error.message === "INVALID_EMAIL") message = "Email invalide";
            return res.status(400).json({ message });
        }
        res.status(200).json({ message: "Connexion réussie", uid: data.localId });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

/* ===================================================== */
/* ================= GOOGLE AUTH ======================= */
/* ===================================================== */
app.post("/api/google-auth", async (req, res) => {
    const { idToken, inscontact } = req.body;
    if (!idToken) return res.status(400).json({ message: "Token manquant" });

    try {
        const decoded = await admin.auth().verifyIdToken(idToken);
        const { uid, name, email } = decoded;

        const userRef = db.collection("users").doc(uid);
        const userDoc = await userRef.get();

        if (!userDoc.exists) {
            if (!inscontact) {
                return res.status(400).json({
                    message: "contact_required",
                    nom: name || "",
                    email: email
                });
            }
            await userRef.set({
                uid,
                nom: name || "",
                email,
                inscontact,
                provider: "google",
                createdAt: admin.firestore.Timestamp.now()
            });
            return res.status(201).json({ message: "Compte créé", uid, isNew: true });
        }

        return res.status(200).json({ message: "Connexion réussie", uid, isNew: false });

    } catch (err) {
        console.error("Erreur Google Auth:", err);
        if (err.code === "auth/id-token-expired") {
            return res.status(401).json({ message: "Session expirée, réessayez" });
        }
        if (err.code === "auth/argument-error") {
            return res.status(401).json({ message: "user_not_found" });
        }
        res.status(500).json({ message: "Erreur serveur" });
    }
});

/* --- mot de passe oublié --- */
app.post("/api/password-reset", async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: "Email requis" });

    try {
        await admin.auth().getUserByEmail(email);
        const link = await admin.auth().generatePasswordResetLink(email);

        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
                user: process.env.GMAIL_USER,
                pass: process.env.GMAIL_PASS
            }
        });

        await transporter.sendMail({
            from: `"ChezMoi" <${process.env.GMAIL_USER}>`,
            to: email,
            subject: "Réinitialisation mot de passe",
            text: `Cliquez sur ce lien pour réinitialiser votre mot de passe :\n${link}`
        });

        res.json({ message: "Email envoyé" });

    } catch (error) {
        res.status(400).json({ message: "Email introuvable" });
    }
});

/* ===================================================== */
/* ================= PUBLIER ANNONCE =================== */
/* ===================================================== */
app.post("/api/annonces", upload.array("images", 15), async (req, res) => {
    try {

        const {
            uid, titre, type_annonce, description, prix, ville, quartier,
            douche, contact, repere, nbChambres, nbPieces, nbSalons, surface,
            etage, eau, electricite, parking, gardien, caution, avanceMax,
            nbDouches, charges, climatiseur, balcon, groupe_electrogene, forage, cuisine,
            type_cuisine, toilettes, meuble, disponibilite, disponibiliteDate, wifi, fraisVisite,
            type_sol, voirie, cloture, viabilisee, facade,
            titre_propriete, negociable, delai_vente
        } = req.body;

        if (!uid || !titre || !type_annonce || !description || !prix || !ville || !quartier || !contact) {
            return res.status(400).json({ message: "Champs obligatoires manquants" });
        }

        if (Number(prix) <= 0) {
            return res.status(400).json({ message: "Prix invalide" });
        }

        try { await admin.auth().getUser(uid); }
        catch { return res.status(400).json({ message: "Utilisateur introuvable" }); }

        // ======= EXPIRATION 30 JOURS =======
        const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
        const expireAt = admin.firestore.Timestamp.fromDate(new Date(Date.now() + THIRTY_DAYS));
        const now = new Date();

        // ======= UPLOAD IMAGES IMGBB DIRECTEMENT =======
        const imagesUrls = [];
        const imagesDeleteUrls = [];

        if (req.files && req.files.length > 0) {
            console.log(`[ImgBB] ${req.files.length} fichier(s) reçu(s)`);
            
            for (const file of req.files) {
                try {
                if (!fs.existsSync(file.path)) {
                    console.error(`[ImgBB] Fichier introuvable: ${file.path}`);
                    continue;
                }

                const base64Image = fs.readFileSync(file.path, { encoding: "base64" });
                console.log(`[ImgBB] Upload de ${file.originalname}, taille base64: ${base64Image.length}`);

                // ✅ ImgBB préfère FormData multipart plutôt que URLSearchParams
                const imgbbForm = new FormData();
                imgbbForm.append("key", process.env.IMGBB_API_KEY);
                imgbbForm.append("image", base64Image);
                imgbbForm.append("expiration", "2592000");

                const response = await fetch("https://api.imgbb.com/1/upload", {
                    method: "POST",
                    body: imgbbForm,
                    headers: imgbbForm.getHeaders()
                });

                const data = await response.json();
                console.log(`[ImgBB] Réponse:`, JSON.stringify(data).slice(0, 200));

                if (data.success && data.data?.url) {
                    imagesUrls.push(data.data.url);
                    if (data.data.delete_url) imagesDeleteUrls.push(data.data.delete_url);
                    console.log(`[ImgBB] ✅ URL: ${data.data.url}`);
                } else {
                    console.error(`[ImgBB] ❌ Échec upload:`, data);
                }

                // Supprimer le fichier temporaire après upload
                if (fs.existsSync(file.path)) fs.unlinkSync(file.path);

                } catch (err) {
                    console.error(`[ImgBB] Erreur pour ${file.originalname}:`, err.message);
                    // Nettoyer le fichier même en cas d'erreur
                    try { if (fs.existsSync(file.path)) fs.unlinkSync(file.path); } catch {}
                }
            }
            console.log(`[ImgBB] Total images uploadées: ${imagesUrls.length}/${req.files.length}`);
        }

        
        // ======= CRÉER ANNONCE DIRECTEMENT PUBLIÉE =======
        const annonceRef = await db.collection("annonces").add({
            uid,
            titre,
            type_annonce,
            description,
            prix,
            ville,
            quartier,
            douche,
            contact,
            repere: repere || "",
            nbChambres: nbChambres || "",
            nbPieces: nbPieces || "",
            nbSalons: nbSalons || "",
            surface: surface || "",
            etage: etage || "",
            eau: eau || "",
            electricite: electricite || "",
            parking: parking || "",
            gardien: gardien || "",
            caution: caution || "",
            avanceMax: avanceMax || "",
            toilettes: toilettes || "",
            meuble: meuble || "",
            disponibilite: disponibilite || "",
            disponibiliteDate: disponibiliteDate || "",
            wifi: wifi || "",
            nbDouches: nbDouches || "",
            charges: charges || "",
            climatiseur: climatiseur || "",
            balcon: balcon || "",
            groupe_electrogene: groupe_electrogene || "",
            forage: forage || "",
            cuisine: cuisine || "",
            type_cuisine: type_cuisine || "",
            fraisVisite: fraisVisite || "",
            type_sol: type_sol || "",
            voirie: voirie || "",
            cloture: cloture || "",
            viabilisee: viabilisee || "",
            facade: facade || "",
            titre_propriete: titre_propriete || "",
            negociable: negociable || "",
            delai_vente: delai_vente || "",

            images: imagesUrls,
            imagesDeleteUrls: imagesDeleteUrls,
            statut: "published",           // publiée directement
            statut_numero: "verrouille",
            date_deblocage: "",
            createdAt: admin.firestore.Timestamp.fromDate(now),
            expireAt                        // 30 jours
        });

        res.status(201).json({
            message: "Annonce publiée avec succès",
            id: annonceRef.id
        });

    } catch (err) {
        console.error("Erreur backend annonces :", err);
        res.status(500).json({ message: err.message });
    }
});

/* ===================================================== */
/* ================= OBTENIR ANNONCES ================= */
/* ===================================================== */
app.get("/api/annonces", async (req, res) => {
    try {
        const now = admin.firestore.Timestamp.now();

        // Supprime annonces expirées
        const expiredSnapshot = await db.collection("annonces").where("expireAt", "<=", now).get();
        for (const doc of expiredSnapshot.docs) {
            const data = doc.data();
            if (data.imagesDeleteUrls) {
                for (const deleteUrl of data.imagesDeleteUrls) {
                    try { await fetch(deleteUrl, { method: "GET" }); }
                    catch(err){ console.error("Erreur suppression image Imgbb :", err); }
                }
            }

            // Supprimer favoris liés
            const favSnapshot = await db.collection("favorites")
                .where("annonceId", "==", doc.id)
                .get();
            for (const favDoc of favSnapshot.docs) {
                await favDoc.ref.delete();
            }

            await doc.ref.delete();
        }

        // Récupère annonces valides
        const snapshot = await db.collection("annonces")
            .where("expireAt", ">", now)
            .where("statut", "==", "published")
            .get();
        const annonces = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        res.json(annonces);

    } catch(err) {
        console.error("Erreur backend get annonces :", err);
        res.status(500).json({ message: err.message });
    }
});

// ================= GET TOUS LES COMPTES =================
app.get("/api/user/accounts", async (req, res) => {
    try {
        const snapshot = await db.collection("users").get();
        const users = snapshot.docs.map(doc => ({
            uid: doc.id,
            nom: doc.data().nom,
            email: doc.data().email,
            avatar: doc.data().avatar || "image/avatar.png"
        }));
        res.json(users);
    } catch (err) {
        console.error("Erreur récupération comptes :", err);
        res.status(500).json({ message: err.message });
    }
});

/* ===================================================== */
/* ================== OBTENIR L'UTILISATEUR ============ */
/* ===================================================== */
app.get("/api/user/:uid", async (req, res) => {
    try {
        const uid = req.params.uid;
        const userDoc = await db.collection("users").doc(uid).get();

        if (!userDoc.exists) {
            return res.status(404).json({ message: "Utilisateur introuvable" });
        }

        res.json(userDoc.data());

    } catch (error) {
        console.error("Erreur récupération utilisateur :", error);
        res.status(500).json({ message: error.message });
    }
});

/* ===================================================== */
/* ========= GET ANNONCES PAR UTILISATEUR ============== */
/* ===================================================== */
app.get("/api/annonces/user/:uid", async (req, res) => {
    try {
        const { uid } = req.params;
        const now = admin.firestore.Timestamp.now();

        const snapshot = await db.collection("annonces")
            .where("uid", "==", uid)
            .where("expireAt", ">", now)
            .where("statut", "==", "published")
            .get();

        const annonces = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));

        res.json(annonces);

    } catch (error) {
        console.error("Erreur récupération annonces utilisateur :", error);
        res.status(500).json({ message: error.message });
    }
});

/* ================= FAVORIS ================= */

// Ajouter une annonce aux favoris
app.post("/api/favorites", async (req, res) => {
    try {
        const { uid, annonceId } = req.body;
        if (!uid || !annonceId) return res.status(400).json({ message: "UID et annonceId requis" });

        const favDoc = await db.collection("favorites")
            .where("uid", "==", uid)
            .where("annonceId", "==", annonceId)
            .get();

        if (!favDoc.empty) return res.status(400).json({ message: "Annonce déjà en favoris" });

        const docRef = await db.collection("favorites").add({
            uid,
            annonceId,
            createdAt: admin.firestore.Timestamp.now()
        });

        res.status(201).json({ message: "Ajouté aux favoris", id: docRef.id });

    } catch (error) {
        console.error("Erreur ajout favoris :", error);
        res.status(500).json({ message: error.message });
    }
});

// Supprimer une annonce des favoris
app.delete("/api/favorites", async (req, res) => {
    try {
        const { uid, annonceId } = req.body;
        if (!uid || !annonceId) return res.status(400).json({ message: "UID et annonceId requis" });

        const favSnapshot = await db.collection("favorites")
            .where("uid", "==", uid)
            .where("annonceId", "==", annonceId)
            .get();

        if (favSnapshot.empty) return res.status(404).json({ message: "Favori introuvable" });

        for (const doc of favSnapshot.docs) {
            await doc.ref.delete();
        }

        res.json({ message: "Favori supprimé" });

    } catch (error) {
        console.error("Erreur suppression favoris :", error);
        res.status(500).json({ message: error.message });
    }
});

// Obtenir toutes les annonces favorites d'un utilisateur
app.get("/api/favorites/:uid", async (req, res) => {
    try {
        const { uid } = req.params;
        const snapshot = await db.collection("favorites")
            .where("uid", "==", uid)
            .get();

        const favoriteIds = snapshot.docs.map(doc => doc.data().annonceId);
        res.json(favoriteIds);

    } catch (error) {
        console.error("Erreur récupération favoris :", error);
        res.status(500).json({ message: error.message });
    }
});

/* ===================================================== */
/* ============ OBTENIR UNE ANNONCE PAR ID =========== */
/* ===================================================== */
app.get("/api/annonces/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const annonceDoc = await db.collection("annonces").doc(id).get();

        if (!annonceDoc.exists) {
            return res.status(404).json({ message: "Annonce introuvable" });
        }

        const annonce = annonceDoc.data();
        const now = admin.firestore.Timestamp.now();

        if (annonce.expireAt && annonce.expireAt <= now) {
            return res.status(410).json({ message: "Annonce expirée" });
        }

        if (annonce.statut !== "published") {
            return res.status(403).json({ message: "Annonce non disponible" });
        }

        res.json({ id: annonceDoc.id, ...annonce });
    } catch (error) {
        console.error("Erreur récupération annonce :", error);
        res.status(500).json({ message: error.message });
    }
});

/* ===================================================== */
/* ================= SUPPRIMER ANNONCE ================= */
/* ===================================================== */
app.delete("/api/annonces/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const { uid } = req.body;

        const annonceRef = db.collection("annonces").doc(id);
        const annonceDoc = await annonceRef.get();

        if (!annonceDoc.exists) {
            return res.status(404).json({ message: "Annonce introuvable" });
        }

        const annonce = annonceDoc.data();

        if (annonce.uid !== uid) {
            return res.status(403).json({ message: "Non autorisé" });
        }

        if (annonce.imagesDeleteUrls && annonce.imagesDeleteUrls.length > 0) {
            for (const deleteUrl of annonce.imagesDeleteUrls) {
                try {
                    await fetch(deleteUrl, { method: "GET" });
                } catch (err) {
                    console.error("Erreur suppression image Imgbb :", err);
                }
            }
        }

        const favSnapshot = await db.collection("favorites")
            .where("annonceId", "==", id)
            .get();

        for (const doc of favSnapshot.docs) {
            await doc.ref.delete();
        }

        await annonceRef.delete();

        res.json({ message: "Annonce supprimée avec succès" });

    } catch (error) {
        console.error("Erreur suppression annonce :", error);
        res.status(500).json({ message: error.message });
    }
});

/* ===================================================== */
/* ================= MODIFIER UTILISATEUR ============== */
/* ===================================================== */
app.put("/api/user/:uid", async (req, res) => {
    try {
        const { uid } = req.params;
        const { nom, email, inscontact } = req.body;

        if (!nom || !email || !inscontact) {
            return res.status(400).json({ message: "Tous les champs sont obligatoires" });
        }

        const userRef = db.collection("users").doc(uid);
        const userDoc = await userRef.get();

        if (!userDoc.exists) {
            return res.status(404).json({ message: "Utilisateur introuvable" });
        }

        await userRef.update({
            nom,
            email,
            inscontact,
            updatedAt: admin.firestore.Timestamp.now()
        });

        await admin.auth().updateUser(uid, { email });

        res.json({ message: "Profil mis à jour avec succès" });

    } catch (error) {
        console.error("Erreur modification utilisateur :", error);
        res.status(500).json({ message: error.message });
    }
});

/* ===================================================== */
/* ================== SIGNALER UN PROBLEME ============= */
/* ===================================================== */
app.post("/api/report", async (req, res) => {
    const { nom, email, sujet, message, annonce } = req.body;

    if (!nom || !email || !sujet || !message || !annonce) {
        return res.status(400).json({ message: "Tous les champs sont obligatoires" });
    }

    try {
        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
                user: process.env.GMAIL_USER,
                pass: process.env.GMAIL_PASS
            }
        });

        const mailOptions = {
            from: `"${nom}" <${email}>`,
            to: process.env.GMAIL_USER,
            subject: `Signalement: ${sujet}`,
            text:
            `Nom: ${nom}
            Email: ${email}

            Message:
            ${message}

            Annonce concernée:
            - ID: ${annonce.id}
            - Titre: ${annonce.titre}
            - Type: ${annonce.type}
            - Ville: ${annonce.ville}
            - Quartier: ${annonce.quartier}
            - Prix: ${annonce.prix} FCFA`
        };

        await transporter.sendMail(mailOptions);
        res.status(200).json({ message: "Signalement envoyé avec succès !" });

    } catch (error) {
        console.error("Erreur envoi mail report :", error);
        res.status(500).json({ message: "Impossible d'envoyer le signalement" });
    }
});

/* ===================================================== */
/* ================== PROPOSER UNE IDEE ================ */
/* ===================================================== */
app.post("/api/idea", async (req, res) => {

    const { nom, email, sujet, message } = req.body;

    if (!nom || !email || !sujet || !message) {
        return res.status(400).json({ message: "Tous les champs sont obligatoires" });
    }

    try {
        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
                user: process.env.GMAIL_USER,
                pass: process.env.GMAIL_PASS
            }
        });

        const mailOptions = {
            from: `"${nom}" <${email}>`,
            to: process.env.GMAIL_USER,
            subject: `💡 Nouvelle idée ChezMoi : ${sujet}`,
            text:
            `Nouvelle idée proposée depuis ChezMoi

            Nom: ${nom}
            Email: ${email}

            Titre de l'idée:
            ${sujet}

            Description:
            ${message}`
        };

        await transporter.sendMail(mailOptions);
        res.status(200).json({ message: "Idée envoyée avec succès !" });

    } catch (error) {
        console.error("Erreur envoi mail idée :", error);
        res.status(500).json({ message: "Impossible d'envoyer l'idée" });
    }
});

/* ===================================================== */
/* ================== LANCEMENT SERVEUR =============== */
/* ===================================================== */
app.listen(PORT, () => {
    console.log(`Backend ChezMoi lancé sur ${PORT}`);
});