package handlers;

import static cds.gen.catalogservice.CatalogService_.BOOKS;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import com.sap.cds.ql.Select;
import com.sap.cds.ql.Update;
import com.sap.cds.services.handler.EventHandler;
import com.sap.cds.services.handler.annotations.On;
import com.sap.cds.services.handler.annotations.ServiceName;
import com.sap.cds.services.persistence.PersistenceService;

import cds.gen.catalogservice.Books;
import cds.gen.catalogservice.CatalogService_;
import cds.gen.catalogservice.GetStockContext;
import cds.gen.catalogservice.SubmitOrderContext;

@Component
@ServiceName(CatalogService_.CDS_NAME)
public class CatalogServiceHandler implements EventHandler {

	@Autowired
	private PersistenceService db;

	@On
	public String submitOrder(SubmitOrderContext context) {
		System.out.println("Received order: " + context.getBook() + " x " + context.getQuantity());
		Integer bookId = context.getBook();
		Integer quantity = context.getQuantity();

		// Read the book
		Books book = db.run(Select.from(BOOKS).where(b -> b.ID().eq(bookId))).first(Books.class)
				.orElse(null);

		if (book == null) {
			context.setResult("Book " + bookId + " not found.");
			context.setCompleted();
			return null;
		}

		if (book.getStock() < quantity) {
			String msg = "Not enough stock for \"" + book.getTitle() + "\". Available: " + book.getStock();
			context.setResult(msg);
			context.setCompleted();
			return null;
		}

		// Update stock
		db.run(Update.entity(BOOKS).byId(bookId)
				.set(b -> b.stock(), s -> s.minus(quantity)));

		int remaining = db.run(Select.from(BOOKS).where(b -> b.ID().eq(bookId))).first(Books.class)
				.map(Books::getStock).orElse(0);
		String result = "Ordered " + quantity + " copy(ies) of \"" + book.getTitle()
				+ "\". Remaining stock: " + remaining;

		context.setResult(result);
		context.setCompleted();
		return null;
	}

	@On
	public Integer getStock(GetStockContext context) {
		Integer bookId = context.getBook();

		Books book = db.run(Select.from(BOOKS).where(b -> b.ID().eq(bookId))).first(Books.class)
				.orElse(null);

		Integer stock = book != null ? book.getStock() : -1;
		context.setResult(stock);
		context.setCompleted();
		return stock;
	}
}
