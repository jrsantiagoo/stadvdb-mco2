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