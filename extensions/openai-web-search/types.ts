export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface SearchResponse {
	answer: string;
	results: SearchResult[];
}

export interface SearchOptions {
	numResults?: number;
	recencyFilter?: "day" | "week" | "month" | "year";
	domainFilter?: string[];
	signal?: AbortSignal;
}
