require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

/* ================= DATABASE ================= */

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT
});

/* ================= ADMIN AUTH ================= */

const ADMIN_KEY = process.env.ADMIN_KEY;

function adminAuth(req, res, next) {
    const key = req.headers["x-admin-key"];
    if (!key || key !== ADMIN_KEY) {
        return res.status(403).json({ error: "Unauthorized - Invalid Admin Key" });
    }
    next();
}

/* ======================================================
   ================= MEMBER LOGIN (MOBILE) ==============
====================================================== */

app.post("/member-login", async (req, res) => {
    try {
        const { phone } = req.body;

        const result = await pool.query(
            "SELECT * FROM members WHERE phone=$1",
            [phone]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Member not found" });
        }

        res.json({ member: result.rows[0] });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* ======================================================
   ================= MEMBERS (ADMIN) ====================
====================================================== */

app.post("/members", adminAuth, async (req, res) => {
    try {
        const {
            name,
            phone,
            membership_start,
            membership_expiry,
            membership_active
        } = req.body;

        const result = await pool.query(
            `INSERT INTO members 
       (name, phone, membership_start, membership_expiry, membership_active)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
            [name, phone, membership_start, membership_expiry, membership_active]
        );

        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/members", adminAuth, async (req, res) => {
    const result = await pool.query("SELECT * FROM members ORDER BY id DESC");
    res.json(result.rows);
});

app.delete("/members/:id", adminAuth, async (req, res) => {
    try {
        const id = req.params.id;

        // Delete transactions first
        await pool.query("DELETE FROM transactions WHERE member_id=$1", [id]);

        // Then delete member
        await pool.query("DELETE FROM members WHERE id=$1", [id]);

        res.json({ message: "Member and related transactions deleted" });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* ======================================================
   ================= BOOKS (ADMIN) ======================
====================================================== */

app.post("/books", adminAuth, async (req, res) => {
    try {
        const { title, author, total_copies } = req.body;

        const result = await pool.query(
            `INSERT INTO books 
       (title, author, total_copies, available_copies)
       VALUES ($1,$2,$3,$3) RETURNING *`,
            [title, author, total_copies]
        );

        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/books", adminAuth, async (req, res) => {
    const result = await pool.query("SELECT * FROM books ORDER BY id DESC");
    res.json(result.rows);
});

app.delete("/books/:id", adminAuth, async (req, res) => {
    await pool.query("DELETE FROM books WHERE id=$1", [req.params.id]);
    res.json({ message: "Book deleted" });
});

/* ======================================================
   ================= ISSUE BOOK =========================
====================================================== */

app.post("/issue", adminAuth, async (req, res) => {
    try {
        const { member_id, book_id } = req.body;

        const bookRes = await pool.query(
            "SELECT * FROM books WHERE id=$1",
            [book_id]
        );

        if (!bookRes.rows.length) {
            return res.status(404).json({ error: "Book not found" });
        }

        if (bookRes.rows[0].available_copies <= 0) {
            return res.status(400).json({ error: "No copies available" });
        }

        const issueDate = new Date();
        const dueDate = new Date();
        dueDate.setDate(issueDate.getDate() + 14);

        await pool.query(
            `INSERT INTO transactions
       (member_id, book_id, issue_date, due_date, status)
       VALUES ($1,$2,$3,$4,'issued')`,
            [member_id, book_id, issueDate, dueDate]
        );

        await pool.query(
            "UPDATE books SET available_copies = available_copies - 1 WHERE id=$1",
            [book_id]
        );

        res.json({ message: "Book issued successfully" });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* ======================================================
   ================= RETURN BOOK ========================
====================================================== */

app.post("/return", adminAuth, async (req, res) => {
    try {
        const { transaction_id } = req.body;

        const tRes = await pool.query(
            "SELECT * FROM transactions WHERE id=$1",
            [transaction_id]
        );

        if (!tRes.rows.length) {
            return res.status(404).json({ error: "Transaction not found" });
        }

        const transaction = tRes.rows[0];
        const today = new Date();
        let fine = 0;

        if (today > transaction.due_date) {
            const daysLate = Math.ceil(
                (today - transaction.due_date) / (1000 * 60 * 60 * 24)
            );
            fine = daysLate * 5;
        }

        await pool.query(
            `UPDATE transactions
       SET return_date=$1, fine_amount=$2, status='returned'
       WHERE id=$3`,
            [today, fine, transaction_id]
        );

        await pool.query(
            "UPDATE books SET available_copies = available_copies + 1 WHERE id=$1",
            [transaction.book_id]
        );

        res.json({ fine });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* ======================================================
   ================= MEMBER BOOKS (MOBILE) ==============
====================================================== */

app.get("/my-books/:memberId", async (req, res) => {
    try {
        const result = await pool.query(
            `
      SELECT t.*, b.title AS book_title
      FROM transactions t
      JOIN books b ON t.book_id = b.id
      WHERE t.member_id=$1
      ORDER BY t.id DESC
      `,
            [req.params.memberId]
        );

        res.json(result.rows);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* ======================================================
   ================= TRANSACTIONS (ADMIN) ===============
====================================================== */

app.get("/transactions", adminAuth, async (req, res) => {
    const result = await pool.query(`
    SELECT t.*, m.name AS member_name, b.title AS book_title
    FROM transactions t
    JOIN members m ON t.member_id = m.id
    JOIN books b ON t.book_id = b.id
    ORDER BY t.id DESC
  `);

    res.json(result.rows);
});

/* ======================================================
   ================= STATS ==============================
====================================================== */

app.get("/stats", adminAuth, async (req, res) => {
    const members = await pool.query("SELECT COUNT(*) FROM members");
    const books = await pool.query("SELECT COUNT(*) FROM books");
    const issued = await pool.query(
        "SELECT COUNT(*) FROM transactions WHERE status='issued'"
    );

    res.json({
        total_members: parseInt(members.rows[0].count),
        total_books: parseInt(books.rows[0].count),
        issued_books: parseInt(issued.rows[0].count)
    });
});

/* ================= START SERVER ================= */

app.listen(5000, () => {
    console.log("Server running on port 5000");
});