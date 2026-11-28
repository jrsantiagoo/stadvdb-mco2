CREATE DATABASE IF NOT EXISTS mco2_db CHARACTER SET utf8mb4;
USE mco2_db;

CREATE TABLE IF NOT EXISTS film (
  film_id         INT           NOT NULL,
  title           VARCHAR(255)  NOT NULL,
  stock           INT           NOT NULL,
  rental_rate     DECIMAL(4,2)  NOT NULL,
  rental_duration TINYINT       NOT NULL,
  PRIMARY KEY (film_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS replication_log (
  log_id       BIGINT        NOT NULL AUTO_INCREMENT,
  origin_node  TINYINT       NOT NULL,
  target_node  TINYINT       NOT NULL,
  op           VARCHAR(16)   NOT NULL,
  film_id      INT           NOT NULL,
  payload      JSON          NULL,
  status       VARCHAR(16)   NOT NULL DEFAULT 'PENDING',
  error_msg    VARCHAR(255)  NULL,
  created_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  applied_at   TIMESTAMP     NULL,
  PRIMARY KEY (log_id),
  INDEX idx_target_status (target_node, status, log_id)
) ENGINE=InnoDB;
