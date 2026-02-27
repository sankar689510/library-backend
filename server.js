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
    port: process.env.DB_PORT,
});

/* ================= MEMBER LOGIN ================= */

app.post("/member-login", async (req, res) => {
    const { phone } = req.body;

    try {
        const result = await pool.query(
            "SELECT * FROM members WHERE phone=$1",
            [phone]
        );

        if (result.rows.length === 0)
            return res.status(404).json({ error: "Member not found" });

        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* ================= ADD MEMBER ================= */

app.post("/admin/add-member", async (req, res) => {
    const { name, phone, membership_start, membership_expiry } = req.body;

    try {
        const result = await pool.query(
            `INSERT INTO members
       (name, phone, membership_start, membership_expiry)
       VALUES ($1,$2,$3,$4)
       RETURNING *`,
            [name, phone, membership_start, membership_expiry]
        );

        res.json(result.rows[0]);
    } catch (err) {
        res.status(400).json({ error: "Phone already exists or invalid data" });
    }
});

/* ================= ADD BOOK ================= */

app.post("/admin/add-book", async (req, res) => {
    const { title, author, barcode } = req.body;

    try {
        const result = await pool.query(
            `INSERT INTO books
       (title, author, barcode)
       VALUES ($1,$2,$3)
       RETURNING *`,
            [title, author, barcode]
        );

        res.json(result.rows[0]);
    } catch (err) {
        res.status(400).json({ error: "Barcode already exists" });
    }
});

/* ================= SCAN BOOK (ISSUE OR RETURN) ================= */

app.post("/scan", async (req, res) => {
    const { member_id, barcode } = req.body;

    try {
        const today = new Date();

        // Check member
        const memberRes = await pool.query(
            "SELECT * FROM members WHERE id=$1",
            [member_id]
        );

        if (memberRes.rows.length === 0)
            return res.status(400).json({ error: "Invalid member" });

        const member = memberRes.rows[0];

        if (new Date(member.membership_expiry) < today)
            return res.status(400).json({ error: "Membership expired" });

        // Find book
        const bookRes = await pool.query(
            "SELECT * FROM books WHERE barcode=$1",
            [barcode]
        );

        if (bookRes.rows.length === 0)
            return res.status(400).json({ error: "Book not found" });

        const book = bookRes.rows[0];

        // ISSUE BOOK
        if (book.status === "available") {
            const dueDate = new Date();
            dueDate.setDate(today.getDate() + 14);

            await pool.query(
                "UPDATE books SET status='issued' WHERE id=$1",
                [book.id]
            );

            await pool.query(
                `INSERT INTO transactions
         (member_id, book_id, issue_date, due_date, status)
         VALUES ($1,$2,$3,$4,'issued')`,
                [member.id, book.id, today, dueDate]
            );

            return res.json({ message: "Book issued successfully" });
        }

        // RETURN BOOK
        if (book.status === "issued") {
            const transRes = await pool.query(
                `SELECT * FROM transactions
         WHERE book_id=$1 AND status='issued'`,
                [book.id]
            );

            const transaction = transRes.rows[0];

            if (!transaction)
                return res.status(400).json({ error: "Transaction not found" });

            if (transaction.member_id !== member.id)
                return res.status(400).json({
                    error: "Book issued to another member",
                });

            let fine = 0;

            if (today > transaction.due_date) {
                const daysLate = Math.ceil(
                    (today - transaction.due_date) / (1000 * 60 * 60 * 24)
                );
                fine = daysLate * 5;
            }

            await pool.query(
                `UPDATE transactions
         SET return_date=$1, fine=$2, status='returned'
         WHERE id=$3`,
                [today, fine, transaction.id]
            );

            await pool.query(
                "UPDATE books SET status='available' WHERE id=$1",
                [book.id]
            );

            return res.json({
                message: "Book returned successfully",
                fine,
            });
        }

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* ================= ADMIN VIEW ================= */

app.get("/admin/members", async (req, res) => {
    const result = await pool.query(
        "SELECT * FROM members ORDER BY id DESC"
    );
    res.json(result.rows);
});

app.get("/admin/books", async (req, res) => {
    const result = await pool.query(
        "SELECT * FROM books ORDER BY id DESC"
    );
    res.json(result.rows);
});

app.get("/admin/transactions", async (req, res) => {
    const result = await pool.query(`
    SELECT t.*, 
           m.name AS member_name, 
           b.title AS book_title
    FROM transactions t
    JOIN members m ON t.member_id = m.id
    JOIN books b ON t.book_id = b.id
    ORDER BY t.id DESC
  `);

    res.json(result.rows);
});
/* ================= DELETE BOOK ================= */
app.delete("/admin/delete-book/:id", async (req, res) => {
    try {
        await pool.query("DELETE FROM books WHERE id=$1", [req.params.id]);
        res.json({ message: "Book deleted" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
/* ================= DELETE MEMBER ================= */
app.delete("/admin/delete-member/:id", async (req, res) => {
    try {
        await pool.query("DELETE FROM members WHERE id=$1", [req.params.id]);
        res.json({ message: "Member removed" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
/* ================= ADMIN ISSUE ================= */
app.post("/admin/issue", async (req, res) => {
    const { member_id, book_id } = req.body;
    const today = new Date();
    const dueDate = new Date();
    dueDate.setDate(today.getDate() + 14);

    try {
        await pool.query(
            "UPDATE books SET status='issued' WHERE id=$1",
            [book_id]
        );

        await pool.query(
            `INSERT INTO transactions
       (member_id, book_id, issue_date, due_date, status)
       VALUES ($1,$2,$3,$4,'issued')`,
            [member_id, book_id, today, dueDate]
        );

        res.json({ message: "Book issued manually" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
/* ================= MEMBER CURRENT BOOKS ================= */
app.get("/member/:id/books", async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT t.id,
              b.title,
              b.author,
              t.issue_date,
              t.due_date
       FROM transactions t
       JOIN books b ON t.book_id = b.id
       WHERE t.member_id = $1
       AND t.status = 'issued'
       ORDER BY t.issue_date DESC`,
            [req.params.id]
        );

        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
/* ================= REQUEST RENEWAL ================= */
app.post("/member/request-renewal", async (req, res) => {
    const { member_id } = req.body;

    try {
        await pool.query(
            "UPDATE members SET renewal_requested = true WHERE id = $1",
            [member_id]
        );

        res.json({ message: "Renewal request sent" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
/* ================= PUBLIC BOOKS LIST ================= */
app.get("/books", async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, title, author, status
       FROM books
       ORDER BY title ASC`
        );

        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
/* ================= SAVE PUSH TOKEN ================= */
app.post("/member/save-push-token", async (req, res) => {
    const { member_id, push_token } = req.body;

    try {
        await pool.query(
            "UPDATE members SET push_token = $1 WHERE id = $2",
            [push_token, member_id]
        );

        res.json({ message: "Push token saved" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
/* ================= START SERVER ================= */

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log("Smart Library Server running on port " + PORT);
});