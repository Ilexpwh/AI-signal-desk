-- Each topic's Beijing day (events/trends.ts, the topics.trend timer): the stories editorial sources
-- reported about it that day, its usual share of all stories (the mean over the 28 days before) and that
-- day's share against it. A day with no story about the topic has no row; baseline and ratio are null
-- with nothing to compare against.
CREATE TABLE topic_trends (
  topic text NOT NULL,
  day date NOT NULL,
  stories integer NOT NULL,
  baseline numeric,
  ratio numeric,
  PRIMARY KEY (topic, day)
);
