CREATE TABLE semantic_documents (
    root_path TEXT NOT NULL,
    path TEXT NOT NULL,
    hash TEXT NOT NULL REFERENCES blobs(hash),
    document_json TEXT NOT NULL,
    PRIMARY KEY (root_path, path, hash)
);